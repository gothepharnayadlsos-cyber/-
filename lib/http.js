/**
 * HTTP 层：静态工作台 + JSON API + SSE。
 *
 * 只依赖 node:http 的 req/res，不引入框架；路由表很小，直接手写匹配。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.text', '.log', '.json'])

/** 读取本地文本文件（首页的“本地路径”入口）。 */
function readLocalText(input) {
  let p = String(input || '').trim()
  if (!p) throw new Error('请填写文件路径')
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1))
  const abs = path.resolve(p)
  let st
  try {
    st = fs.statSync(abs)
  } catch {
    throw new Error(`找不到文件：${abs}`)
  }
  if (!st.isFile()) throw new Error('这个路径不是文件')
  if (st.size > 4 * 1024 * 1024) throw new Error('文件超过 4 MB，建议先分卷')
  const ext = path.extname(abs).toLowerCase()
  if (!TEXT_EXTS.has(ext)) throw new Error(`只支持 ${[...TEXT_EXTS].join(' / ')}`)
  const text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')
  return { path: abs, name: path.basename(abs), chars: [...text].length, text }
}

function serveStatic(res, rel) {
  const safe = rel.replace(/\\/g, '/').replace(/\.\./g, '')
  const file = path.join(WEB_DIR, safe)
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  })
  res.end(fs.readFileSync(file))
}

export function createHttpHandler({ store, service }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    if (!pathname.startsWith('/fanwork')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const rest = pathname.slice('/fanwork'.length) || '/'

    // 强制自带 API：没有配置时，所有会调用模型的入口一律拒绝
    const needsApi =
      (rest === '/api/projects' && req.method === 'POST')
      || (/^\/api\/projects\/[^/]+\/run$/.test(rest) && req.method === 'POST')
      || (rest === '/api/settings/test' && req.method === 'POST')

    if (needsApi && !service.isConfigured()) {
      return sendJson(res, 403, {
        error: '还没有配置 API：请先在首页「模型」里填写接口地址与 API Key',
        code: 'NOT_CONFIGURED',
      })
    }

    try {
      // ---------- 静态资源 ----------
      if (req.method === 'GET' && (rest === '/' || rest === '/index.html')) return serveStatic(res, 'index.html')
      if (req.method === 'GET' && rest.startsWith('/assets/')) return serveStatic(res, rest.slice('/assets/'.length))

      // ---------- 健康检查 ----------
      if (req.method === 'GET' && rest === '/api/health') {
        const s = service.getSettings()
        const host = req.headers.host || `127.0.0.1:${req.socket.localPort}`
        return sendJson(res, 200, {
          ok: true,
          version: '0.1.0',
          url: `http://${host}/fanwork`,
          provider: service.provider,
          model: service.model,
          dataDir: store.dataDir,
          settings: s,
        })
      }

      // ---------- 模型设置 ----------
      if (rest === '/api/settings' && req.method === 'GET') {
        return sendJson(res, 200, service.getSettings())
      }
      if (rest === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req)
        const view = service.updateSettings({
          ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
        })
        return sendJson(res, 200, view)
      }
      if (rest === '/api/settings/test' && req.method === 'POST') {
        const out = await service.probe({ text: '只回复两个字：可用', maxTokens: 256 })
        return sendJson(res, 200, {
          ok: Boolean(out.ok),
          configured: service.isConfigured(),
          model: service.model,
          ms: out.ms,
          sample: out.sample || '',
          error: out.error || null,
        })
      }

      // ---------- 读取本地文本文件 ----------
      if (rest === '/api/read-file' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const file = readLocalText(body.path)
          return sendJson(res, 200, file)
        } catch (err) {
          return sendJson(res, 400, { error: err.message })
        }
      }

      // ---------- 诊断：直接打一次模型调用 ----------
      if (rest === '/api/_probe') {
        const q = url.searchParams
        const out = await service.probe({
          ...(q.get('system') ? { system: q.get('system') } : {}),
          ...(q.get('text') ? { text: q.get('text') } : {}),
          ...(q.get('maxTokens') ? { maxTokens: Number(q.get('maxTokens')) } : {}),
          ...(q.get('reasoningEffort') ? { reasoningEffort: q.get('reasoningEffort') } : {}),
        })
        return sendJson(res, 200, out)
      }

      // ---------- 项目列表 / 新建 ----------
      if (rest === '/api/projects' && req.method === 'GET') {
        return sendJson(res, 200, { projects: store.list() })
      }
      if (rest === '/api/projects' && req.method === 'POST') {
        const body = await readBody(req)
        const source = String(body.source || '').trim()
        if (source.length < 50) return sendJson(res, 400, { error: '原文太短，至少 50 字' })
        if (source.length > 80000) return sendJson(res, 400, { error: '原文超过 8 万字，请先截取一章或分卷处理' })
        const brief = {
          direction: body.brief?.direction || 'sequel',
          targetWords: Math.min(8000, Math.max(500, Number(body.brief?.targetWords) || 3000)),
          pov: body.brief?.pov === 'first' ? 'first' : 'third',
          style: String(body.brief?.style || '').trim(),
          taboos: String(body.brief?.taboos || '').split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
          extra: String(body.brief?.extra || '').trim(),
          candidates: Math.min(4, Math.max(1, Number(body.brief?.candidates) || service.config.candidates || 3)),
        }
        const project = store.create({ source, brief, title: String(body.title || '').trim() || '未命名二创' })
        return sendJson(res, 200, { project })
      }

      // ---------- 单项目 ----------
      const m = rest.match(/^\/api\/projects\/([^/]+)(\/[a-z]+)?$/)
      if (m) {
        const id = decodeURIComponent(m[1])
        const action = m[2] || ''
        const project = store.load(id)
        if (!project) return sendJson(res, 404, { error: '项目不存在' })

        if (!action && req.method === 'GET') return sendJson(res, 200, { project })

        if (action === '/run' && req.method === 'POST') {
          const body = await readBody(req)
          return service.runStage(project, String(body.stage || ''), req, res)
        }
        if (action === '/decisions' && req.method === 'POST') {
          const body = await readBody(req)
          const decisions = Array.isArray(body.decisions) ? body.decisions : []
          if (!decisions.length) return sendJson(res, 400, { error: '没有收到任何裁决' })
          const result = service.submitDecisions(project, decisions)
          return sendJson(res, 200, { project: result })
        }
        if (action === '/select' && req.method === 'POST') {
          const body = await readBody(req)
          const draft = project.drafts.find((d) => d.id === body.draftId)
          if (!draft) return sendJson(res, 404, { error: '稿件不存在' })
          project.selectedDraftId = draft.id
          project.stage = 'finalizing'
          store.save(project)
          const exported = service.finalize(project)
          return sendJson(res, 200, { project, exported })
        }
        if (action === '/cancel' && req.method === 'POST') {
          service.cancel(id)
          return sendJson(res, 200, { ok: true })
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (err) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, 500, { error: err?.message || String(err) })
    }
  }
}
