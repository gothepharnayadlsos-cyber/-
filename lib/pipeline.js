/**
 * 五阶段流水线：canon → diagnose → fix（确定性） → draft → audit。
 *
 * 每个阶段只做一件事，并且把过程通过 emit 推给 SSE；
 * 任何一步失败都保留已完成的部分，由上层决定重试哪一段。
 */
import {
  CANON_SYSTEM, DIAGNOSE_SYSTEM, DRAFT_SYSTEM, AUDIT_SYSTEM,
  canonMessages, diagnoseMessages, draftMessages, auditMessages,
  parseDraftOutput, angleFor,
} from './prompts.js'

const CATEGORIES = new Set(['C1','C2','C3','C4','G1','G2','G3','G4','G5','S1','S2','S3','S4','E1','E2','E3','E4'])
const SEVERITIES = new Set(['P0', 'P1', 'P2'])
const STRATEGIES = new Set(['F1', 'F2', 'F3', 'F4', 'F5', 'F6'])

function splitSource(text, limit = 12000) {
  if (text.length <= limit) return [text]
  const parts = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.6) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) parts.push(rest)
  return parts
}

/** 长文本按段落均匀采样，保留原文句子（证据仍然可引用）。 */
function sampleSource(text, maxChars = 14000) {
  if (text.length <= maxChars) return text
  const paragraphs = text.split(/\n+/).filter((p) => p.trim())
  const avg = Math.max(1, Math.ceil(text.length / paragraphs.length))
  const keep = Math.max(1, Math.floor(maxChars / avg))
  const step = paragraphs.length / keep
  const picked = []
  for (let i = 0; i < keep; i++) picked.push(paragraphs[Math.floor(i * step)])
  return `【说明】原文共 ${text.length} 字，以下为按段落均匀采样的约 ${maxChars} 字节选，段号仍对应原文顺序。\n\n${picked.join('\n')}`
}

/** 有并发上限的 map。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

function uniqueBy(list, key) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const k = key(item)
    if (k === undefined || k === null || k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

function normalizeCanon(raw, fallbackTitle) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const arr = (v) => (Array.isArray(v) ? v : [])
  return {
    title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : fallbackTitle || '',
    characters: arr(c.characters).map((x) => ({
      name: String(x?.name || '').trim(),
      aliases: arr(x?.aliases).map(String),
      traits: arr(x?.traits).map(String),
      voice: typeof x?.voice === 'string' ? x.voice : '',
      relations: arr(x?.relations).map(String),
    })).filter((x) => x.name),
    world: {
      rules: arr(c.world?.rules).map(String),
      constraints: arr(c.world?.constraints).map(String),
    },
    timeline: arr(c.timeline).map((x, i) => ({
      order: Number.isFinite(x?.order) ? x.order : i + 1,
      when: String(x?.when || ''),
      event: String(x?.event || ''),
      paragraph: Number.isFinite(x?.paragraph) ? x.paragraph : null,
    })).filter((x) => x.event),
    keyEvents: arr(c.keyEvents).map((x) => ({
      act: String(x?.act || ''),
      summary: String(x?.summary || ''),
      paragraph: Number.isFinite(x?.paragraph) ? x.paragraph : null,
    })).filter((x) => x.summary),
    foreshadows: arr(c.foreshadows).map((x) => ({
      setup: String(x?.setup || ''),
      payoff: String(x?.payoff || ''),
      status: x?.status === 'closed' ? 'closed' : 'open',
    })).filter((x) => x.setup),
    openQuestions: arr(c.openQuestions).map(String).filter(Boolean),
    narrative: {
      pov: String(c.narrative?.pov || ''),
      tense: String(c.narrative?.tense || ''),
      unreliableNarrator: Boolean(c.narrative?.unreliableNarrator),
    },
  }
}

function normalizeRisks(raw) {
  const list = Array.isArray(raw?.risks) ? raw.risks : []
  const seen = new Set()
  const out = []
  list.forEach((r, idx) => {
    const category = CATEGORIES.has(r?.category) ? r.category : 'G2'
    const severity = SEVERITIES.has(r?.severity) ? r.severity : 'P1'
    const title = String(r?.title || '').trim()
    if (!title) return
    const key = `${category}|${title}`
    if (seen.has(key)) return
    seen.add(key)
    const fixes = (Array.isArray(r?.fixes) ? r.fixes : []).slice(0, 3).map((f, i) => ({
      id: String(f?.id || 'ABC'[i] || String.fromCharCode(65 + i)),
      strategy: STRATEGIES.has(f?.strategy) ? f.strategy : 'F1',
      label: String(f?.label || '方案').slice(0, 8),
      description: String(f?.description || ''),
      cost: Math.min(3, Math.max(1, Number(f?.cost) || 2)),
      blastRadius: Math.max(0, Number(f?.blastRadius) || 1),
      sideEffects: (Array.isArray(f?.sideEffects) ? f.sideEffects : []).filter((x) => CATEGORIES.has(x)),
      confidence: Math.min(1, Math.max(0, Number(f?.confidence) || 0.6)),
    }))
    out.push({
      id: `R${idx + 1}`,
      category,
      severity,
      title,
      reasoning: String(r?.reasoning || ''),
      evidence: (Array.isArray(r?.evidence) ? r.evidence : []).map((e) => ({
        quote: String(e?.quote || ''),
        paragraph: Number.isFinite(e?.paragraph) ? e.paragraph : null,
      })).filter((e) => e.quote),
      downstream: (Array.isArray(r?.downstream) ? r.downstream : []).map(String),
      fixes: fixes.length ? fixes : [{
        id: 'A', strategy: 'F1', label: '最小修补', description: '按问题描述小幅修改相关段落。',
        cost: 1, blastRadius: 1, sideEffects: [], confidence: 0.5,
      }],
      recommended: String(r?.recommended || fixes[0]?.id || 'A'),
      status: 'open',
    })
  })
  return { risks: out, summary: String(raw?.summary || ''), health: Number.isFinite(raw?.health) ? raw.health : null }
}

function normalizeAudit(raw) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : d)
  const scores = {
    canon: num(raw?.scores?.canon, 60),
    ooc: num(raw?.scores?.ooc, 60),
    logic: num(raw?.scores?.logic, 60),
    coverage: num(raw?.scores?.coverage, 60),
    compliance: num(raw?.scores?.compliance, 80),
    craft: num(raw?.scores?.craft, 60),
  }
  const weights = { canon: 0.25, ooc: 0.2, logic: 0.2, coverage: 0.15, compliance: 0.1, craft: 0.1 }
  const weighted = Object.entries(weights).reduce((sum, [k, w]) => sum + scores[k] * w, 0)
  const items = (Array.isArray(raw?.items) ? raw.items : []).map((it, i) => ({
    id: `A${i + 1}`,
    category: CATEGORIES.has(it?.category) ? it.category : 'E3',
    severity: SEVERITIES.has(it?.severity) ? it.severity : 'P2',
    message: String(it?.message || '').slice(0, 80),
    quote: String(it?.quote || ''),
  })).filter((x) => x.message)
  const hasP0 = items.some((x) => x.severity === 'P0')
  return {
    scores,
    overall: Math.round(hasP0 ? Math.min(59, weighted) : weighted),
    items,
    coverage: (Array.isArray(raw?.coverage) ? raw.coverage : []).map((c) => ({
      requirement: String(c?.requirement || ''),
      met: Boolean(c?.met),
      note: String(c?.note || ''),
    })),
    summary: String(raw?.summary || ''),
  }
}

/** 给诊断用的骨架摘要：只保留判断所需的字段，避免把整份骨架再喂一遍。 */
function canonDigest(canon) {
  if (!canon) return null
  return {
    title: canon.title,
    characters: (canon.characters || []).slice(0, 12).map((c) => ({
      name: c.name,
      traits: (c.traits || []).slice(0, 3),
      relations: (c.relations || []).slice(0, 2),
    })),
    rules: (canon.world?.rules || []).slice(0, 8),
    timeline: (canon.timeline || []).slice(0, 20).map((t) => `${t.when}：${t.event}`),
    keyEvents: (canon.keyEvents || []).slice(0, 12).map((e) => e.summary),
    openQuestions: (canon.openQuestions || []).slice(0, 6),
    narrative: canon.narrative,
  }
}

export function createPipeline({ store, llm, emit, log = () => {}, concurrency = 4 }) {
  async function runCanon(project, signal) {
    const parts = splitSource(project.source.text)
    const parallel = Math.max(1, Math.min(concurrency, parts.length))
    emit({ type: 'stage', stage: 'analyzing', detail: parts.length > 1 ? `分 ${parts.length} 段解析（并发 ${parallel}）` : '解析故事骨架' })
    let done = 0
    const results = await mapLimit(parts, parallel, async (part, i) => {
      if (signal?.aborted) throw new Error('已取消')
      const started = Date.now()
      try {
        const { value, usage } = await llm.json({
          system: CANON_SYSTEM,
          messages: canonMessages(part, { part: i + 1, total: parts.length }),
          temperature: 0.1,
          maxTokens: 10000,
          signal,
          repairHint: '只输出故事骨架 JSON。',
        })
        log('canon.chunk', { index: i + 1, total: parts.length, ms: Date.now() - started, chars: part.length, out: usage?.outputTokens })
        emit({ type: 'progress', stage: 'analyzing', done: ++done, total: parts.length })
        return normalizeCanon(value, project.title)
      } catch (err) {
        log('canon.chunk.error', { index: i + 1, ms: Date.now() - started, error: err.message })
        throw err
      }
    })
    const merged = results[0] || normalizeCanon({}, project.title)
    for (const r of results.slice(1)) {
      merged.characters = uniqueBy([...merged.characters, ...r.characters], (c) => c.name)
      merged.world.rules = uniqueBy([...merged.world.rules, ...r.world.rules], (x) => x)
      merged.world.constraints = uniqueBy([...merged.world.constraints, ...r.world.constraints], (x) => x)
      merged.timeline.push(...r.timeline)
      merged.keyEvents.push(...r.keyEvents)
      merged.foreshadows.push(...r.foreshadows)
      merged.openQuestions = uniqueBy([...merged.openQuestions, ...r.openQuestions], (x) => x)
    }
    merged.timeline.sort((a, b) => a.order - b.order)
    // 合并后再兜一次上限，防止多段叠加成巨型骨架
    merged.characters = merged.characters.slice(0, 12)
    merged.timeline = merged.timeline.slice(0, 30)
    merged.keyEvents = merged.keyEvents.slice(0, 20)
    merged.foreshadows = merged.foreshadows.slice(0, 10)
    merged.world.rules = merged.world.rules.slice(0, 10)
    merged.world.constraints = merged.world.constraints.slice(0, 10)
    merged.openQuestions = merged.openQuestions.slice(0, 8)
    project.canon = merged
    store.save(project)
    emit({ type: 'canon', canon: merged })
    return merged
  }

  async function runDiagnose(project, signal) {
    const raw = project.source.text
    const sampleChars = 10000
    const digest = sampleSource(raw, sampleChars)
    const canon = canonDigest(project.canon)
    emit({
      type: 'stage',
      stage: 'diagnosing',
      detail: raw.length > sampleChars ? `扫描逻辑漏洞（长文，按 ${Math.round(digest.length / 1000)}k 字采样）` : '扫描逻辑漏洞',
    })
    const started = Date.now()
    const { value, usage } = await llm.json({
      system: DIAGNOSE_SYSTEM,
      messages: diagnoseMessages({ ...project, canon, source: { text: digest } }),
      temperature: 0.2,
      maxTokens: 16000,
      signal,
      repairHint: '只输出含 risks 数组的 JSON。',
    })
    log('diagnose.done', {
      ms: Date.now() - started,
      inputChars: digest.length,
      canonChars: JSON.stringify(canon).length,
      outTokens: usage?.outputTokens,
      risks: Array.isArray(value?.risks) ? value.risks.length : 0,
    })
    const normalized = normalizeRisks(value)
    project.risks = normalized.risks
    project.diagnose = { summary: normalized.summary, health: normalized.health, at: Date.now(), sampled: raw.length > sampleChars }
    store.save(project)
    store.saveReport(project, project.round, { kind: 'diagnose', ...project.diagnose, risks: project.risks })
    emit({ type: 'diagnose', summary: normalized.summary, health: normalized.health, risks: normalized.risks })
    return normalized
  }

  function applyDecisions(project, incoming) {
    const round = project.round
    for (const d of incoming) {
      if (d.optionId) {
        const risk = project.risks.find((r) => r.id === d.riskId)
        const fix = risk?.fixes.find((f) => f.id === d.optionId)
        if (!risk || !fix) continue
        risk.status = 'decided'
        const text = `${risk.title}（${risk.id}）采用方案「${fix.label}」：${fix.description}`
        project.decisions.push({ id: `D${project.decisions.length + 1}`, round, scope: 'risk', riskId: risk.id, optionId: d.optionId, text, at: Date.now() })
      } else if (d.text) {
        const text = String(d.text).trim()
        if (!text) continue
        project.decisions.push({ id: `D${project.decisions.length + 1}`, round, scope: d.scope || 'global', riskId: d.riskId || null, text, at: Date.now() })
        if (d.riskId) {
          const risk = project.risks.find((r) => r.id === d.riskId)
          if (risk) risk.status = 'decided'
        }
      }
    }
    for (const r of project.risks) if (r.status === 'open') r.status = 'accepted'
    store.save(project)
    emit({ type: 'decisions', decisions: project.decisions })
    return project.decisions
  }

  async function runDrafts(project, signal) {
    const count = Math.max(1, Math.min(4, project.brief?.candidates || 3))
    emit({ type: 'stage', stage: 'generating', detail: `并行生成 ${count} 稿` })
    const jobs = []
    for (let i = 0; i < count; i++) {
      const angle = angleFor(i)
      const id = `v${project.round + 1}-${i + 1}`
      jobs.push((async () => {
        try {
          const baseCap = Math.min(16000, Math.max(6000, Math.round((project.brief?.targetWords || 3000) * 4)))
          const call = (cap) => llm.streamText({
            system: DRAFT_SYSTEM,
            messages: draftMessages(project, angle),
            temperature: 0.9,
            maxTokens: cap,
            signal,
            onDelta: (delta) => emit({ type: 'delta', draftId: id, text: delta }),
          })
          let out = await call(baseCap)
          // 推理型模型可能把预算全花在 reasoning 上，正文为空；加大预算重试一次
          if (!out.text.trim()) {
            emit({ type: 'progress', stage: 'generating', detail: `${angle.name} 空稿，加大预算重试` })
            out = await call(Math.min(16000, baseCap * 2))
          }
          const parsed = parseDraftOutput(out.text)
          const draft = {
            id,
            angle: angle.name,
            title: parsed.title,
            logline: parsed.logline,
            body: parsed.body,
            wordCount: [...parsed.body].length,
            usage: out.usage || null,
            finishReason: out.reason,
            reasoningChars: out.reasoningChars || 0,
            at: Date.now(),
          }
          if (!draft.body.trim()) {
            emit({ type: 'error', scope: 'draft', draftId: id, message: `正文为空（finish=${out.reason}，reasoning=${out.reasoningChars} 字符）` })
            return null
          }
          store.saveDraftFile(project, draft)
          emit({ type: 'draft', draft })
          return draft
        } catch (err) {
          emit({ type: 'error', scope: 'draft', draftId: id, message: err.message })
          return null
        }
      })())
    }
    const drafts = (await Promise.all(jobs)).filter(Boolean)
    project.drafts = [...project.drafts.filter((d) => !drafts.some((n) => n.id === d.id)), ...drafts]
    store.save(project)
    if (!drafts.length) throw new Error('所有候选稿都生成失败')
    return drafts
  }

  async function runAudits(project, signal) {
    const fresh = project.drafts.filter((d) => !project.audits.some((a) => a.draftId === d.id))
    emit({ type: 'stage', stage: 'auditing', detail: `审核 ${fresh.length} 稿` })
    const jobs = fresh.map((draft) => (async () => {
      try {
        const { value } = await llm.json({
          system: AUDIT_SYSTEM,
          messages: auditMessages(project, draft),
          temperature: 0.1,
          maxTokens: 6000,
          signal,
          repairHint: '只输出审核 JSON。',
        })
        const report = { draftId: draft.id, ...normalizeAudit(value) }
        emit({ type: 'audit', audit: report })
        return report
      } catch (err) {
        emit({ type: 'error', scope: 'audit', draftId: draft.id, message: err.message, detail: err.raw || '' })
        return null
      }
    })())
    const reports = (await Promise.all(jobs)).filter(Boolean)
    project.audits = [...project.audits.filter((a) => !reports.some((r) => r.draftId === a.draftId)), ...reports]
    store.save(project)
    store.saveReport(project, project.round, {
      kind: 'audit',
      at: Date.now(),
      audits: reports,
    })
    return reports
  }

  function exportFinal(project) {
    const draft = project.drafts.find((d) => d.id === project.selectedDraftId)
    if (!draft) throw new Error('还没有选定稿件')
    return store.exportMarkdown(project, draft)
  }

  return { runCanon, runDiagnose, applyDecisions, runDrafts, runAudits, exportFinal }
}
