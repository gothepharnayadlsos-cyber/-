/**
 * 插件契约检查：用假的 cordis ctx 验证入口导出与注册行为，不需要 DSH 宿主。
 *   node scripts/plugin-check.mjs
 */
import { fileURLToPath } from 'node:url'
import * as plugin from '../lib/index.js'

const dataDir = fileURLToPath(new URL('../.fanwork-check', import.meta.url))
const calls = []
const disposers = []

const ctx = {
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
  },
  webServer: {
    register(route) {
      calls.push({ kind: 'route', path: route.path, type: route.kind, hasHandler: typeof route.handler === 'function' })
      return () => calls.push({ kind: 'dispose-route' })
    },
    getOrigin: () => 'http://127.0.0.1:55603',
  },
  commands: {
    register(def) {
      calls.push({ kind: 'command', name: def.name, definitionId: def.definitionId, handler: def.handler })
      return () => {}
    },
  },
  llm: { stream: async function* () {} },
  logger: { info: (m) => calls.push({ kind: 'log', message: m }) },
}

const failures = []
const check = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.log(`  ✗ ${msg}`); failures.push(msg) }
}

console.log('1) 导出形状')
check(plugin.name === 'fanwork', 'name = fanwork')
check(Array.isArray(plugin.inject), 'inject 是数组')
check(['webServer', 'commands'].every((s) => plugin.inject.includes(s)), 'inject 含 webServer/commands（不再依赖 ctx.llm）')
check(typeof plugin.apply === 'function', 'apply 是函数')
check(plugin.default === undefined, '没有 export default（避免 unwrapExports 丢 inject）')

console.log('2) apply 注册')
plugin.apply(ctx, { candidates: 2, model: 'deepseek-flash', dataDir })
const route = calls.find((c) => c.kind === 'route')
const cmd = calls.find((c) => c.kind === 'command')
check(route?.path === '/fanwork', '注册了 /fanwork 前缀路由')
check(route?.type === 'prefix', '路由类型是 prefix')
check(route?.hasHandler === true, '路由带 handler')
check(cmd?.name === 'fanwork', '注册了 /fanwork 命令')
check(cmd?.definitionId === 'dsh-fanwork', '命令带 definitionId')
check(disposers.length >= 1, '注册返回了 disposer（可随插件卸载）')

console.log('3) 命令返回值')
const res = cmd?.handler?.({})
check(res?.kind === 'success', `handler 返回 success（${res?.text}）`)
check(String(res?.text || '').includes('/fanwork'), '返回里带工作台地址')

if (failures.length === 0) console.log('\n契约检查通过')
else { console.log(`\n${failures.length} 项未通过`); process.exit(1) }
