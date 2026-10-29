/**
 * 端到端冒烟测试：不用浏览器，直接打 HTTP API 走完整条流水线。
 *   node scripts/e2e-test.mjs [baseUrl]
 */
const BASE = `${process.argv[2] || 'http://127.0.0.1:7788'}/fanwork`

const SOURCE = `第 1 段　雨下了一整夜。
第 2 段　七年前，林夏和陈默在同一间出租屋里写下了第一行代码。那时他们相信，只要代码跑得动，世界就会让路。
第 3 段　三年前，陈默带着核心技术离开，只留下一张字条。林夏发过誓，这辈子都不会原谅。
第 4 段　她把那张字条烧了，灰烬落进洗手池，被水冲走。
第 5 段　今夜的雨和那晚一样大。
第 6 段　门铃响了。门外站着陈默，浑身湿透，手里攥着一枚生了锈的旧钥匙。
第 7 段　"我回来了。"他说。她笑了笑，说都过去了。
第 8 段　他们隔着餐桌坐下，谁也没有先开口。
第 9 段　陈默说，当年离开是为了替她挡下一场官司。
第 10 段　林夏没有问细节，只是把那枚钥匙推到桌子中间。
第 11 段　"那这又是什么？"她问。
第 12 段　钥匙在她掌心发烫。`

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
        try {
          events.push(JSON.parse(line.slice(6)))
        } catch { /* ignore */ }
      }
    }
  }
  return events
}

function assert(cond, message) {
  if (!cond) throw new Error(`断言失败：${message}`)
  console.log(`  ✓ ${message}`)
}

const t0 = Date.now()
console.log('1) 健康检查')
const health = await api('/api/health', undefined, 'GET')
assert(health.ok === true, `服务在线（model=${health.model}）`)

console.log('2) 建项目')
const { project } = await api('/api/projects', {
  source: SOURCE,
  brief: { direction: 'sequel', targetWords: 800, pov: 'third', style: '克制', taboos: '不要复活角色', candidates: 2 },
})
assert(project.id && project.stage === 'input', `项目已创建 ${project.id}`)

console.log('3) 体检（canon + diagnose）')
const analyzeEvents = await runStage(project.id, 'analyze')
const types = analyzeEvents.map((e) => e.type)
assert(types.includes('canon'), '收到骨架事件')
assert(types.includes('diagnose'), '收到风险报告事件')
assert(types.includes('done'), '阶段正常结束')
const risks = analyzeEvents.find((e) => e.type === 'diagnose').risks
assert(risks.length >= 2, `识别出 ${risks.length} 条风险`)
assert(risks[0].fixes.length >= 2, `首条风险有 ${risks[0].fixes.length} 个修复方案`)

console.log('4) 裁决')
const afterDecision = await api(`/api/projects/${project.id}/decisions`, {
  decisions: [
    { riskId: risks[0].id, optionId: risks[0].fixes[1].id },
    { riskId: risks[1].id, text: '结尾要留白，不要点破钥匙开哪扇门' },
  ],
})
assert(afterDecision.project.decisions.length >= 2, '裁决已落台账')

console.log('5) 生成 + 审核')
const genEvents = await runStage(project.id, 'generate')
for (const err of genEvents.filter((e) => e.type === 'error')) {
  console.log('  ! error:', err.message, err.detail ? `\n    ${String(err.detail).slice(0, 400)}` : '')
}
const drafts = genEvents.filter((e) => e.type === 'draft')
const audits = genEvents.filter((e) => e.type === 'audit')
const deltas = genEvents.filter((e) => e.type === 'delta').length
assert(drafts.length === 2, `生成 ${drafts.length} 稿`)
assert(deltas > 10, `流式增量 ${deltas} 次`)
assert(audits.length === 2, `审核 ${audits.length} 稿`)
assert(drafts[0].draft.body.length > 50, '稿件正文非空')

console.log('6) 定稿导出')
const picked = await api(`/api/projects/${project.id}/select`, { draftId: drafts[0].draft.id })
assert(picked.project.stage === 'done', '项目进入 done')
assert(picked.exported.path.endsWith('export.md'), `导出文件：${picked.exported.path}`)
assert(picked.exported.markdown.includes('二创风险报告'), '导出内容含风险报告附录')

console.log(`\n全部通过，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
