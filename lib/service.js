/**
 * 服务层：把 HTTP 请求翻译成流水线动作，负责 SSE 推送、取消与快照。
 */
import { createPipeline } from './pipeline.js'
import { makeRemoteLlm } from './remote-llm.js'
import { createSettings } from './settings.js'
import { createLogger } from './log.js'

function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  let closed = false
  const send = (event) => {
    if (closed) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  // 长模型调用期间没有任何事件，靠注释心跳把连接钉住（也防止中间层空闲超时）
  const heartbeat = setInterval(() => {
    if (closed) return
    res.write(': ping\n\n')
  }, 15000)
  return {
    send,
    close() {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      res.end()
    },
  }
}

export function snapshot(project) {
  return {
    id: project.id,
    title: project.title,
    stage: project.stage,
    round: project.round,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    source: { wordCount: project.source?.wordCount || 0 },
    brief: project.brief,
    canon: project.canon,
    diagnose: project.diagnose,
    risks: project.risks,
    decisions: project.decisions,
    drafts: project.drafts,
    audits: project.audits,
    selectedDraftId: project.selectedDraftId,
    final: project.final,
    error: project.error || null,
  }
}

export function createService({ ctx, config, store }) {
  const log = createLogger(store.dataDir)
  const settings = createSettings(store.dataDir)

  // 只用使用者自己的 API：直连客户端按（地址, 模型, Key）缓存，设置一改就重建
  let remote = null
  let remoteSig = ''
  function currentLlm() {
    const s = settings.load()
    if (!settings.isConfigured(s)) {
      const err = new Error('还没有配置 API：请先在首页填写接口地址与 API Key')
      err.code = 'NOT_CONFIGURED'
      throw err
    }
    const sig = `${s.baseUrl}|${s.model}|${s.apiKey}`
    if (!remote || remoteSig !== sig) {
      remote = makeRemoteLlm({
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        timeoutMs: Number(config.callTimeoutMs) || 600000,
        log,
      })
      remoteSig = sig
    }
    return remote
  }

  const llm = {
    get provider() {
      try {
        return currentLlm().provider
      } catch {
        return 'unconfigured'
      }
    },
    get model() {
      try {
        return currentLlm().model
      } catch {
        return '未配置'
      }
    },
    streamText: (opts) => currentLlm().streamText(opts),
    json: (opts) => currentLlm().json(opts),
  }

  const running = new Map()

  function pipelineFor(emit) {
    return createPipeline({ store, llm, emit, log, concurrency: Number(config.concurrency) || 4 })
  }

  function cancel(id) {
    const c = running.get(id)
    if (c) c.abort()
  }

  function submitDecisions(project, decisions) {
    const pipeline = pipelineFor(() => {})
    project.round += 1
    pipeline.applyDecisions(project, decisions)
    project.stage = 'candidate_review'
    store.save(project)
    return snapshot(project)
  }

  function finalize(project) {
    const pipeline = pipelineFor(() => {})
    const exported = pipeline.exportFinal(project)
    project.stage = 'done'
    store.save(project)
    return exported
  }

  async function runStage(project, stage, req, res) {
    const sse = openSse(res)
    const controller = new AbortController()
    running.set(project.id, controller)
    const emit = (e) => sse.send(e)
    const pipeline = pipelineFor(emit)
    const started = Date.now()
    log('stage.start', { project: project.id, stage, chars: project.source?.text?.length || 0 })
    project.error = null

    const onClose = () => {
      if (!res.writableEnded) controller.abort()
    }
    req.on('close', onClose)

    try {
      if (stage === 'analyze') {
        // 骨架已经建好时只重跑诊断，避免重试时把最贵的一步再做一遍
        if (project.canon) {
          emit({ type: 'stage', stage: 'analyzing', detail: '复用已有故事骨架' })
          emit({ type: 'canon', canon: project.canon })
        } else {
          project.stage = 'analyzing'
          store.save(project)
          await pipeline.runCanon(project, controller.signal)
        }
        project.stage = 'diagnosing'
        store.save(project)
        await pipeline.runDiagnose(project, controller.signal)
        project.stage = 'risk_review'
      } else if (stage === 'generate') {
        project.stage = 'generating'
        store.save(project)
        await pipeline.runDrafts(project, controller.signal)
        project.stage = 'auditing'
        store.save(project)
        await pipeline.runAudits(project, controller.signal)
        project.stage = 'candidate_review'
        project.round += 1
      } else if (stage === 'regate') {
        // 用最新裁决重跑一批稿（保留历史稿）
        project.stage = 'generating'
        project.drafts = []
        project.audits = []
        store.save(project)
        await pipeline.runDrafts(project, controller.signal)
        project.stage = 'auditing'
        store.save(project)
        await pipeline.runAudits(project, controller.signal)
        project.stage = 'candidate_review'
        project.round += 1
      } else {
        throw new Error(`未知阶段：${stage}`)
      }
      store.save(project)
      log('stage.done', { project: project.id, stage, ms: Date.now() - started })
      emit({ type: 'done', stage, project: snapshot(project) })
    } catch (err) {
      const aborted = controller.signal.aborted || /aborted|已取消/i.test(err?.message || '')
      project.error = aborted ? '已取消' : (err?.message || String(err))
      store.save(project)
      log('stage.error', { project: project.id, stage, ms: Date.now() - started, aborted, error: project.error })
      emit({
        type: 'error',
        scope: 'stage',
        message: project.error,
        aborted,
        detail: err?.failure
          ? JSON.stringify(err.failure).slice(0, 1500)
          : (err?.raw ? String(err.raw).slice(0, 1200) : String(err?.stack || '').slice(0, 1500)),
      })
    } finally {
      req.off('close', onClose)
      running.delete(project.id)
      sse.close()
    }
  }

  return {
    get provider() { return llm.provider },
    get model() { return llm.model },
    config,
    snapshot,
    runStage,
    submitDecisions,
    finalize,
    cancel,
    getSettings: () => settings.publicView(),
    isConfigured: () => settings.isConfigured(),
    updateSettings: (patch) => {
      const saved = settings.save(patch)
      remote = null // 设置变了，下次调用重建客户端
      log('settings.update', { model: saved.model, baseUrl: saved.baseUrl, hasKey: Boolean(saved.apiKey) })
      return settings.publicView()
    },
    // 诊断用：直接发一次模型调用，验证 ctx.llm 通道
    async probe({ system = '你是测试助手，只回答 OK。', text = 'ping', maxTokens = 64, temperature = 0, reasoningEffort } = {}) {
      const started = Date.now()
      try {
        const out = await llm.streamText({
          system,
          messages: [{ role: 'user', content: text }],
          maxTokens,
          temperature,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        })
        return {
          ok: true,
          ms: Date.now() - started,
          chars: out.text.length,
          sample: out.text.slice(0, 120),
          reason: out.reason,
          effort: out.effort,
          reasoningChars: out.reasoningChars,
          deltaCount: out.deltaCount,
          chunkTypes: out.chunkTypes,
        }
      } catch (err) {
        return { ok: false, ms: Date.now() - started, error: err.message, detail: err.failure || null }
      }
    },
  }
}
