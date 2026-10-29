/**
 * 在已有项目上跑「裁决 → 生成 → 审核 → 定稿」，用于打真实模型。
 *   node scripts/e2e-real.mjs [baseUrl] [projectId]
 * 不给 projectId 时自动取最近一个 stage=risk_review 的项目。
 */
const BASE = `${process.argv[2] || 'http://127.0.0.1:57908'}/fanwork`

async function api(path, body, method = 'POST') {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error || ''}`)
  return data
}

async function runStage(id, stage) {
  const res = await fetch(`${BASE}/api/projects/${id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage }),
  })
  if (!res.ok) throw new Error(`run ${stage} -> ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try { events.push(JSON.parse(line.slice(6))) } catch { /* ignore */ }
      }
    }
  }
  return events
}

let id = process.argv[3]
if (!id) {
  const { projects } = await api('/api/projects', undefined, 'GET')
  const target = projects.find((p) => p.stage === 'risk_review')
  if (!target) throw new Error('没有处于 risk_review 的项目，请先跑 debug-analyze.mjs')
  id = target.id
}
console.log('project:', id)

const { project } = await api(`/api/projects/${id}`, undefined, 'GET')
const risks = project.risks || []
console.log(`风险 ${risks.length} 条，健康度 ${project.diagnose?.health}`)

// 第一条选推荐方案，第二条写“更多要求”
const decisions = []
if (risks[0]) {
  const fix = risks[0].fixes.find((f) => f.id === risks[0].recommended) || risks[0].fixes[0]
  decisions.push({ riskId: risks[0].id, optionId: fix.id })
  console.log(`R1 采用 ${fix.id} ${fix.label}`)
}
if (risks[1]) {
  decisions.push({ riskId: risks[1].id, text: '这一处不要新增场景，用一句回忆带过即可' })
  console.log('R2 自定义要求：用一句回忆带过')
}
if (decisions.length) {
  await api(`/api/projects/${id}/decisions`, { decisions })
  console.log('裁决已提交')
}

const t0 = Date.now()
const events = await runStage(id, 'generate')
const drafts = events.filter((e) => e.type === 'draft').map((e) => e.draft)
const audits = events.filter((e) => e.type === 'audit').map((e) => e.audit)
const errors = events.filter((e) => e.type === 'error')
console.log(`生成耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，稿件 ${drafts.length} 篇，审核 ${audits.length} 篇`)
for (const err of errors) console.log('  error:', err.message, err.detail ? String(err.detail).slice(0, 300) : '')

for (const d of drafts) {
  console.log(`\n—— ${d.title}（${d.angle}）${d.wordCount} 字`)
  console.log(`   立意：${d.logline}`)
  console.log(`   ${d.body.slice(0, 160).replace(/\n/g, ' ')}…`)
  const a = audits.find((x) => x.draftId === d.id)
  if (a) console.log(`   评分：综合 ${a.overall} · 一致 ${a.scores.canon} · 人物 ${a.scores.ooc} · 逻辑 ${a.scores.logic} · 需求 ${a.scores.coverage} · 合规 ${a.scores.compliance} · 文笔 ${a.scores.craft}`)
}

if (drafts[0]) {
  const picked = await api(`/api/projects/${id}/select`, { draftId: drafts[0].id })
  console.log(`\n已定稿 → ${picked.exported.path}`)
  console.log(`导出 ${picked.exported.markdown.length} 字符，含风险报告：${picked.exported.markdown.includes('二创风险报告')}`)
}
