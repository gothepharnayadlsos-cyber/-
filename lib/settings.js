/**
 * 插件级设置：只支持「使用者自己的 API」（出于安全与可审计考虑，不提供内置模型选项）。
 * 存在 <dataDir>/settings.json，文件权限尽量收紧；对外只暴露掩码后的 Key。
 *
 * 未配置 = 没有 apiKey / baseUrl / model 任一；此时服务端会拒绝一切生成请求。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
}

export function createSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json')
  let cache = null
  let cachedMtime = null

  function defaults() {
    return { ...DEFAULT_SETTINGS }
  }

  function load() {
    let st = null
    try {
      st = fs.statSync(file)
    } catch {
      st = null
    }
    // 文件被删掉（例如换机器、清理凭据）时，内存缓存也要跟着失效
    if (!st) {
      cache = defaults()
      cachedMtime = null
      return cache
    }
    if (cache && cachedMtime === st.mtimeMs) return cache

    let raw = {}
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      raw = {}
    }
    cache = {
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : DEFAULT_SETTINGS.baseUrl,
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_SETTINGS.model,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    }
    cachedMtime = st.mtimeMs
    return cache
  }

  function save(patch = {}) {
    const prev = load()
    const next = { ...prev }
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim()
    if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim()
    // apiKey 语义：不传=保持不变；传字符串=按传入值设置（空字符串即清除）
    if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim()

    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
      try {
        fs.chmodSync(file, 0o600)
      } catch {
        /* Windows 上 chmod 语义有限，忽略 */
      }
    } catch {
      /* 写失败时仅影响持久化 */
    }
    cache = next
    try {
      cachedMtime = fs.statSync(file).mtimeMs
    } catch {
      cachedMtime = null
    }
    return next
  }

  function isConfigured(s = load()) {
    return Boolean(s.apiKey && s.baseUrl && s.model)
  }

  function publicView() {
    const s = load()
    const key = s.apiKey || ''
    return {
      configured: isConfigured(s),
      baseUrl: s.baseUrl,
      model: s.model,
      hasKey: Boolean(key),
      keyMask: key ? `${key.slice(0, 4)}****${key.slice(-4)}` : '',
    }
  }

  return { load, save, publicView, isConfigured, file }
}
