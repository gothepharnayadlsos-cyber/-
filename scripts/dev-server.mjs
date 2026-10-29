/**
 * 本地开发/演示服务器：跑的是同一套 Host 代码，但模型换成内置的假接口。
 *
 * 生产里插件只用「使用者自己的 API」；这里为了离线演示，启动时会在本机起一个
 * OpenAI 兼容的 /mock/chat/completions，并把设置指向它。
 *
 *   node scripts/dev-server.mjs                 # 假模型，端口 7788
 *   PORT=9000 node scripts/dev-server.mjs
 *   DEEPSEEK_API_KEY=sk-... node scripts/dev-server.mjs   # 用真 Key（会把它写进本地 settings）
 */
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'
import { createService } from '../lib/service.js'
import { createHttpHandler } from '../lib/http.js'
import { createSettings } from '../lib/settings.js'

const PORT = Number(process.env.PORT || 7788)
const API_KEY = process.env.DEEPSEEK_API_KEY || ''

/* ----------------------------- 假模型 ----------------------------- */

const CANON = {
  title: '测试故事',
  characters: [
    { name: '林夏', aliases: ['夏'], traits: ['固执', '记仇'], voice: '短句', relations: ['与陈默是旧友'] },
    { name: '陈默', aliases: [], traits: ['沉默', '愧疚'], voice: '少言', relations: ['林夏的旧友'] },
  ],
  world: { rules: ['记忆可以被抽取，但会留下空洞'], constraints: ['抽取记忆需要双方自愿'] },
  timeline: [
    { order: 1, when: '七年前', event: '林夏与陈默合伙创业', paragraph: 2 },
    { order: 2, when: '三年前', event: '陈默带着核心技术离开', paragraph: 3 },
  ],
  keyEvents: [{ act: '第一幕', summary: '林夏发现陈默当年的离开另有隐情', paragraph: 7 }],
  foreshadows: [{ setup: '第 3 段提到那枚旧钥匙', payoff: '', status: 'open' }],
  openQuestions: ['陈默为什么离开'],
  narrative: { pov: '第三人称限制', tense: '过去时', unreliableNarrator: false },
}

const DIAGNOSE = {
  summary: '人物动机链基本成立，但关键转折缺少铺垫，结尾未闭合。',
  health: 63,
  risks: [
    {
      id: 'R1', category: 'G1', severity: 'P0', title: '原谅缺乏动机铺垫',
      reasoning: '第 3 段明确林夏"绝不原谅"，第 7 段她立刻说"都过去了"，中间没有任何认知转变事件。',
      evidence: [{ quote: '她笑了笑，说都过去了。', paragraph: 7 }, { quote: '她发过誓，这辈子都不会原谅。', paragraph: 3 }],
      downstream: ['第 9 段', '第 12 段'],
      fixes: [
        { id: 'A', strategy: 'F1', label: '最小修补', description: '在第 7 段前补一句她动摇的触发点。', cost: 1, blastRadius: 1, sideEffects: ['S2'], confidence: 0.7 },
        { id: 'B', strategy: 'F2', label: '补写前史', description: '新增一场戏交代真相揭露的契机。', cost: 2, blastRadius: 3, sideEffects: ['S2'], confidence: 0.8 },
        { id: 'C', strategy: 'F6', label: '反转利用', description: '把原谅改写为她已知情并准备报复。', cost: 3, blastRadius: 5, sideEffects: ['C4'], confidence: 0.6 },
      ],
      recommended: 'B', status: 'open',
    },
    {
      id: 'R2', category: 'S4', severity: 'P1', title: '结尾主线未闭合',
      reasoning: '第 12 段抛出"钥匙到底开哪扇门"，之后直接结束，没有回答。',
      evidence: [{ quote: '钥匙在她掌心发烫。', paragraph: 12 }],
      downstream: [],
      fixes: [
        { id: 'A', strategy: 'F1', label: '补一句暗示', description: '结尾补一句指向门的位置。', cost: 1, blastRadius: 1, sideEffects: [], confidence: 0.65 },
        { id: 'B', strategy: 'F2', label: '加一场戏', description: '在结尾前加她找到门的一场戏。', cost: 2, blastRadius: 2, sideEffects: ['S2'], confidence: 0.7 },
      ],
      recommended: 'A', status: 'open',
    },
  ],
}

const AUDIT = {
  scores: { canon: 88, ooc: 82, logic: 80, coverage: 85, compliance: 95, craft: 84 },
  overall: 85,
  items: [{ category: 'S2', severity: 'P1', message: '中段节奏略快，转折缺少过渡', quote: '' }],
  coverage: [{ requirement: '方向：续写', met: true }, { requirement: '视角：第三人称', met: true }],
  summary: '整体成立，注意中段过渡。',
}

function stubText(system, userText) {
  if (system.includes('故事结构分析师')) return JSON.stringify(CANON)
  if (system.includes('逻辑漏洞')) return JSON.stringify(DIAGNOSE)
  if (system.includes('同人写作者')) {
    const angle = userText.includes('正面推进') ? '正面推进' : userText.includes('侧面切片') ? '侧面切片' : '反向假设'
    return `【标题】潮汐线（${angle}）\n【立意】她选择记住，而不是原谅。\n【正文】\n雨停的时候，林夏把那枚钥匙放在桌上，金属与木面接触，发出一声很轻的响。\n\n陈默没有说话。他知道自己欠她的不是一句解释，而是一段被抽走的七年。\n\n“我不原谅你。”她说，“但我记得你。”\n\n这是她能给出的全部。窗外的潮水退下去，露出湿漉漉的堤岸，像一段终于被翻出来的旧账。`
  }
  if (system.includes('审稿人')) return JSON.stringify(AUDIT)
  return 'OK'
}

function mockChat(req, res) {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch { /* ignore */ }
    const system = (payload.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const userText = (payload.messages || []).filter((m) => m.role !== 'system').map((m) => m.content).join('\n')
    const text = stubText(system, userText)

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
    const step = 16
    for (let i = 0; i < text.length; i += step) {
      const chunk = {
        choices: [{ delta: { content: text.slice(i, i + step) }, finish_reason: null }],
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      if (res.destroyed) return
      await new Promise((r) => setTimeout(r, 5))
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: Math.ceil(text.length / 2) } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
}

/* ----------------------------- 启动 ----------------------------- */

const config = {
  candidates: 3,
  concurrency: 4,
  callTimeoutMs: 600000,
  dataDir: process.env.FANWORK_DATA || fileURLToPath(new URL('../.fanwork-data', import.meta.url)),
}
const store = createStore(config)
const service = createService({ ctx: {}, config, store })

// 演示用：没配置时自动指向本机假接口
const settings = createSettings(store.dataDir)
if (!settings.isConfigured() || process.env.FANWORK_FORCE_MOCK === '1') {
  settings.save({
    baseUrl: API_KEY ? 'https://api.deepseek.com' : `http://127.0.0.1:${PORT}/mock`,
    model: API_KEY ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat') : 'stub',
    ...(API_KEY ? { apiKey: API_KEY } : {}),
  })
  if (!API_KEY) settings.save({ apiKey: 'stub-local' })
}

const handler = createHttpHandler({ store, service })
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/mock/chat/completions')) return mockChat(req, res)
  handler(req, res).catch((err) => {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: err.message }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  const s = settings.publicView()
  console.log(`[fanwork] 模式=${API_KEY ? '真实 API' : '本机假接口'}  数据目录=${store.dataDir}`)
  console.log(`[fanwork] http://127.0.0.1:${PORT}/fanwork  (${s.baseUrl} · ${s.model})`)
})
