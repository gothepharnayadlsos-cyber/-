/**
 * 把 dsh-fanwork 安装进某个 DSH profile（默认 desktop）。
 *
 * 做三件事（都可逆）：
 *   1. 在 profile/node_modules 下建立指向本包的 junction/symlink
 *   2. 在 profile/package.json 的 dependencies 里写入 "dsh-fanwork": "link:<本包绝对路径>"
 *   3. 把 "dsh-fanwork" 追加进 dsh.profile.bundles
 *
 * 用法：
 *   node scripts/install-profile.mjs [profileName]
 *   node scripts/install-profile.mjs desktop --uninstall
 *
 * 说明：DSH 的 desktop profile 由 Desktop 载体管理。装完需要重启 DSH（或由插件页重挂）才生效；
 * CLI 的 `dsh plugin add` 在 Desktop 运行时会被拒绝，所以这里直接改 profile 清单。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const self = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const uninstall = argv.includes('--uninstall')
const profileName = argv.find((a) => !a.startsWith('-')) || 'desktop'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profileName)
const pkgPath = path.join(profileDir, 'package.json')
const linkPath = path.join(profileDir, 'node_modules', 'dsh-fanwork')

if (!fs.existsSync(pkgPath)) {
  console.error(`找不到 profile：${pkgPath}`)
  process.exit(1)
}

const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
json.dependencies = json.dependencies || {}
json.dsh = json.dsh || {}
json.dsh.profile = json.dsh.profile || {}
json.dsh.profile.bundles = json.dsh.profile.bundles || []

// 备份一次
const backup = `${pkgPath}.bak-${Date.now()}`
fs.copyFileSync(pkgPath, backup)

if (uninstall) {
  delete json.dependencies['dsh-fanwork']
  json.dsh.profile.bundles = json.dsh.profile.bundles.filter((b) => b !== 'dsh-fanwork')
  if (fs.existsSync(linkPath) || fs.existsSync(linkPath + '\\')) fs.rmSync(linkPath, { recursive: true, force: true })
  fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2), 'utf8')
  console.log(`已卸载 dsh-fanwork（备份：${backup}）`)
  process.exit(0)
}

// 1. 链接
if (!fs.existsSync(linkPath)) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(self, linkPath, 'junction')
  console.log(`已建立链接：${linkPath} -> ${self}`)
} else {
  console.log(`链接已存在：${linkPath}`)
}

// 2. 依赖
json.dependencies['dsh-fanwork'] = `link:${self}`

// 3. bundle
if (!json.dsh.profile.bundles.includes('dsh-fanwork')) {
  json.dsh.profile.bundles.push('dsh-fanwork')
}

fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2), 'utf8')
console.log(`已更新：${pkgPath}`)
console.log(`  dependencies.dsh-fanwork = link:${self}`)
console.log(`  dsh.profile.bundles = [${json.dsh.profile.bundles.join(', ')}]`)
console.log(`\n下一步：重启 DeepSeek Harness，然后访问 http://127.0.0.1:<端口>/fanwork`)
console.log(`备份文件：${backup}`)
