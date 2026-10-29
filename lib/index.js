/**
 * 二创工坊（dsh-fanwork）Host 半。
 *
 * 职责：
 *  - 在 /fanwork 提供自带的工作台（静态页 + JSON API + SSE）
 *  - 通过 ctx.llm 跑「体检 → 裁决 → 生成 → 审核 → 定稿」流水线
 *  - 通过 /fanwork 命令把地址告诉用户/模型
 *
 * 约定：
 *  - 只做具名导出，不写 export default（Loader 的 unwrapExports 会丢 inject）。
 *  - 不 import 任何 @deepseek-ai/* 包：插件以 link: 方式挂在工作区，
 *    Node 的 ESM 解析会从真实路径向上找，拿不到 profile 里的依赖。
 *    配置直接读 apply(ctx, config)，默认值在 DEFAULT_CONFIG 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createStore } from './store.js'
import { createService } from './service.js'
import { createHttpHandler } from './http.js'

export const name = 'fanwork'

export const inject = ['webServer', 'commands']

export const DEFAULT_CONFIG = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  candidates: 3,
  concurrency: 4,
  reasoningEffort: 'low',
  callTimeoutMs: 600000,
  dataDir: '',
}

export function apply(ctx, config = {}) {
  const settings = {
    provider: config.provider || DEFAULT_CONFIG.provider,
    model: config.model || DEFAULT_CONFIG.model,
    candidates: Math.min(4, Math.max(1, Number(config.candidates) || DEFAULT_CONFIG.candidates)),
    concurrency: Math.min(6, Math.max(1, Number(config.concurrency) || DEFAULT_CONFIG.concurrency)),
    reasoningEffort: config.reasoningEffort ?? DEFAULT_CONFIG.reasoningEffort,
    callTimeoutMs: Number(config.callTimeoutMs) || DEFAULT_CONFIG.callTimeoutMs,
    dataDir: config.dataDir || DEFAULT_CONFIG.dataDir,
  }

  const store = createStore(settings)
  const service = createService({ ctx, config: settings, store })
  const handler = createHttpHandler({ store, service })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/fanwork', handler }))

  ctx.commands.register({
    definitionId: 'dsh-fanwork',
    name: 'fanwork',
    description: '打开二创工坊工作台',
    handler: () => {
      let origin = ''
      try {
        origin = ctx.webServer.getOrigin()
      } catch {
        origin = ''
      }
      return {
        kind: 'success',
        text: origin ? `二创工坊已就绪：${origin}/fanwork` : '二创工坊已就绪：访问 /fanwork',
      }
    },
  })

  if (ctx.logger?.info) ctx.logger.info(`[fanwork] 工作台已挂载，数据目录：${store.dataDir}`)

  // 端口每次启动都可能变化：把当前地址写到数据目录，方便下次找回来
  const rememberUrl = () => {
    try {
      const origin = ctx.webServer.getOrigin()
      fs.mkdirSync(store.dataDir, { recursive: true })
      fs.writeFileSync(path.join(store.dataDir, 'last-url.txt'), `${origin}/fanwork\n`, 'utf8')
    } catch {
      /* 绑定尚未完成时忽略 */
    }
  }
  const timer = setTimeout(rememberUrl, 2000)
  if (typeof timer.unref === 'function') timer.unref()
}
