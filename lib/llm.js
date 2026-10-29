/**
 * LLM 访问层：把 ctx.llm.stream 包成两个好用的原语。
 *
 * - streamText(): 流式拿到整段文本（同时把增量交给 onDelta，用 SSE 推给浏览器）
 * - json():      要求模型输出 JSON，抽取 + 解析 + 失败重试
 *
 * DSH 的 GenerateOptions 没有 response_format，结构化输出只能靠提示词 + 解析兜底，
 * 所以这里的 JSON 抽取必须足够宽容：代码块围栏、前后废话、尾逗号都要能处理。
 *
 * 长文本场景的两个关键保护：
 * - 单次调用有超时（默认 300s），超时按可重试处理；
 * - TRANSPORT / RATE_LIMIT / 超时 自动重试（最多 2 次），但只在还没吐出任何正文时重试，
 *   避免 UI 上出现重复文本。
 */

export class LlmError extends Error {
  constructor(message, { code, retryable = false } = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.retryable = retryable
  }
}

const RETRYABLE_CODES = new Set(['TRANSPORT', 'RATE_LIMIT', 'TIMEOUT', 'ABORTED', 'UNKNOWN'])

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从一段可能夹带解释文字的输出里抽出第一个平衡的 JSON 值。 */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const s = text.trim()
  // 优先取 ```json 围栏
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(s)

  for (const c of candidates) {
    const start = c.search(/[[{]/)
    if (start < 0) continue
    const open = c[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < c.length; i++) {
      const ch = c[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          const slice = c.slice(start, i + 1)
          try {
            return JSON.parse(slice)
          } catch {
            try {
              return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'))
            } catch {
              break
            }
          }
        }
      }
    }
  }
  return null
}

function normalizeMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role || 'user',
    content: typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : m.content,
  }))
}

export function makeLlm(ctx, config, log = () => {}) {
  const provider = config.provider || 'deepseek-official'
  const model = config.model || 'deepseek-flash'
  const timeoutMs = Number(config.callTimeoutMs) || 300000
  const defaultEffort = config.reasoningEffort || ''

  /** 合并外部 signal 与超时 signal。 */
  function withTimeout(signal) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    const onAbort = () => ac.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    return {
      signal: ac.signal,
      cleanup() {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
      },
      timedOut: () => ac.signal.aborted && !(signal && signal.aborted),
    }
  }

  async function streamOnce({ system, messages, temperature, maxTokens, reasoningEffort, signal, onDelta }) {
    let text = ''
    let usage = null
    let reason = 'stop'
    let reasoningChars = 0
    let deltaCount = 0
    const chunkTypes = {}
    const guard = withTimeout(signal)

    try {
      for await (const chunk of ctx.llm.stream({
        provider,
        model,
        system,
        messages: normalizeMessages(messages),
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(reasoningEffort || defaultEffort ? { reasoningEffort: reasoningEffort || defaultEffort } : {}),
        signal: guard.signal,
      })) {
        chunkTypes[chunk.type] = (chunkTypes[chunk.type] || 0) + 1
        if (chunk.type === 'text-delta') {
          deltaCount++
          text += chunk.text
          if (onDelta) onDelta(chunk.text)
        } else if (chunk.type === 'reasoning-delta') {
          reasoningChars += (chunk.text || '').length
        } else if (chunk.type === 'usage') {
          usage = chunk.usage
        } else if (chunk.type === 'finish') {
          const r = chunk.reason
          if (r && typeof r === 'object' && (r.kind === 'error' || r.kind === 'aborted')) {
            const failure = r.failure || {}
            const code = failure.code || r.kind
            const err = new LlmError(
              `模型调用失败：${code} ${failure.message || ''}`.trim(),
              { code, retryable: RETRYABLE_CODES.has(code) || r.kind === 'aborted' },
            )
            err.failure = failure
            err.emitted = text.length
            throw err
          }
          reason = typeof r === 'string' ? r : (r?.kind || 'stop')
        }
      }
      return { text, usage, reason, reasoningChars, deltaCount, chunkTypes, effort: reasoningEffort || defaultEffort || 'default' }
    } catch (err) {
      if (guard.timedOut() && !(err instanceof LlmError)) {
        const e = new LlmError(`模型调用超时（${Math.round(timeoutMs / 1000)}s）`, { code: 'TIMEOUT', retryable: true })
        e.emitted = text.length
        throw e
      }
      if (err instanceof LlmError) {
        if (err.emitted === undefined) err.emitted = text.length
        throw err
      }
      const e = new LlmError(`模型调用异常：${err?.message || err}`, { code: 'UNKNOWN', retryable: true })
      e.emitted = text.length
      throw e
    } finally {
      guard.cleanup()
    }
  }

  /** 带重试的流式调用；只有「还没吐出正文」时才重试，避免重复输出。 */
  async function streamText(opts) {
    let lastErr
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) log('llm.retry', { attempt, code: lastErr?.code })
        return await streamOnce(opts)
      } catch (err) {
        lastErr = err
        const retryable = err.retryable || RETRYABLE_CODES.has(err.code)
        const emitted = Number(err.emitted) || 0
        if (!retryable || opts.signal?.aborted || emitted > 0 || attempt >= 2) throw err
        await delay(1200 * (attempt + 1))
      }
    }
    throw lastErr
  }

  /** 要求模型输出 JSON；解析失败时追加一次“只输出 JSON”的修复调用。 */
  async function json(spec) {
    return createJsonRunner(streamText, log)(spec)
  }

  return { provider, model, streamText, json }
}

/**
 * 把「流式调用」包装成「要 JSON」的通用逻辑，内置与直连 API 共用。
 * @param {(opts: object) => Promise<{text: string, usage?: object, reason?: string}>} streamText
 */
export function createJsonRunner(streamText, log = () => {}) {
  return async function json({ system, messages, temperature = 0.2, maxTokens = 8000, signal, onDelta, repairHint }) {
    let cap = Math.max(maxTokens, 6000)
    let first = await streamText({ system, messages, temperature, maxTokens: cap, signal, onDelta })
    let value = extractJson(first.text)

    // 看起来被截断（或直接没解析出来）就先加预算重来一次，再走修复提示
    const looksTruncated = (t) => {
      const s = String(t || '').trim()
      if (!s) return false
      return !/[}\]]\s*$/.test(s)
    }
    if (value === null && (first.reason === 'max-tokens' || first.reason === 'length' || looksTruncated(first.text)) && cap < 16000) {
      cap = Math.min(16000, Math.max(cap * 2, 12000))
      log('json.retry.bigger', { from: maxTokens, to: cap, reason: first.reason, chars: first.text.length })
      first = await streamText({ system, messages, temperature, maxTokens: cap, signal, onDelta })
      value = extractJson(first.text)
    }
    if (value !== null) return { value, usage: first.usage, raw: first.text }

    // 一个字都没出来：说明预算全被推理吃掉，回灌空内容没有意义，直接报清楚
    if (!first.text.trim()) {
      log('json.empty', { reason: first.reason, outTokens: first.usage?.outputTokens, effort: first.effort })
      const err = new LlmError(
        `模型把 ${first.usage?.outputTokens || cap} tokens 全部用在了推理上，没有输出正文；请把 reasoningEffort 调低或提高 maxTokens`,
        { code: 'REASONING_BUDGET', retryable: false },
      )
      err.raw = ''
      throw err
    }

    log('json.bad.first', {
      reason: first.reason,
      chars: first.text.length,
      outTokens: first.usage?.outputTokens,
      head: first.text.slice(0, 200),
      tail: first.text.slice(-200),
    })

    const repair = await streamText({
      system,
      // 注意：这里必须用 user 消息回灌上一次输出。
      // DSH 的 LLM 运行时要求 assistant 消息带 source（会话消息），
      // 手写一个 { role: 'assistant' } 会在 forAdapter() 里抛
      // "Cannot read properties of undefined (reading 'replayState')"。
      messages: [
        ...messages,
        {
          role: 'user',
          content: `上一次输出无法解析为 JSON，原文如下：\n<<<\n${first.text.slice(0, 6000)}\n>>>\n\n请只输出合法 JSON，不要任何解释、不要代码块围栏。${repairHint ? '\n要求：' + repairHint : ''}`,
        },
      ],
      temperature: 0,
      maxTokens: 16000,
      signal,
    })
    value = extractJson(repair.text)
    if (value === null) {
      const err = new LlmError('模型两次都没有返回可解析的 JSON', { code: 'BAD_JSON', retryable: true })
      err.raw = (repair.text || first.text || '').slice(0, 800)
      throw err
    }
    return { value, usage: repair.usage, raw: repair.text }
  }
}
