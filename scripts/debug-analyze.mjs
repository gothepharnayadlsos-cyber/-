/**
 * 调试用：建一个项目并跑 analyze，打印全部 SSE 事件与错误详情。
 *   node scripts/debug-analyze.mjs [baseUrl] [projectId]
 */
const BASE = `${process.argv[2] || 'http://127.0.0.1:57908'}/fanwork`
const SOURCE = `第 1 段　雨下了一整夜。
第 2 段　七年前，林夏和陈默在同一间出租屋里写下了第一行代码。那时他们相信，只要代码跑得动，世界就会让路。
第 3 段　三年前，陈默带着核心技术离开，只留下一张字条。林夏发过誓，这辈子都不会原谅。
第 4 段　她把那张字条烧了，灰烬落进洗手池，被水冲走。
第 5 段　今夜的雨和那晚一样大。
第 6 段　门铃响了。门外站着陈默，浑身湿透，手里攥着一枚生了锈的旧钥匙。
第 7 段　"我回来了。"他说。她笑了笑，都过去了。
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
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

const existing = process.argv[3]
let id = existing
if (!id) {
  const created = await api('/api/projects', {
    source: SOURCE,
    brief: { direction: 'sequel', targetWords: 600, pov: 'third', candidates: 1 },
  })
  id = created.project.id
  console.log('project:', id)
}

const res = await fetch(`${BASE}/api/projects/${id}/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'analyze' }),
})
console.log('http', res.status)
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
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
      const ev = JSON.parse(line.slice(6))
      if (ev.type === 'delta') continue
      if (ev.type === 'diagnose') {
        console.log('diagnose:', JSON.stringify({ summary: ev.summary, health: ev.health, risks: ev.risks.length }))
        continue
      }
      if (ev.type === 'canon') {
        console.log('canon:', JSON.stringify({ title: ev.canon.title, chars: ev.canon.characters.length, rules: ev.canon.world.rules.length }))
        continue
      }
      console.log(ev.type, JSON.stringify(ev).slice(0, 1800))
    }
  }
}

const snap = await api(`/api/projects/${id}`, undefined, 'GET')
console.log('final stage:', snap.project.stage, '| error:', snap.project.error)
