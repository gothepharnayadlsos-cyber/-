/**
 * 极简结构化日志：一行一个 JSON，写到 <dataDir>/fanwork.log。
 * 出问题时可据此判断卡在哪一次模型调用、耗时多久。
 */
import fs from 'node:fs'
import path from 'node:path'

export function createLogger(dataDir) {
  const file = path.join(dataDir, 'fanwork.log')
  return function log(event, data = {}) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`, 'utf8')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}
