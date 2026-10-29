/**
 * 项目持久化：一个项目一个目录，project.json 是唯一真源，大块文本单独落盘。
 *
 * <dataDir>/projects/<id>/
 *   project.json        结构化状态（含骨架、风险、裁决、稿件元信息）
 *   source.txt          原文
 *   drafts/<draftId>.md 稿件正文
 *   reports/round-N.json 每轮风险报告快照
 *   export.md           定稿导出
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true })

export function resolveDataDir(config = {}) {
  if (config.dataDir) return path.resolve(config.dataDir)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'fanwork')
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function createStore(config) {
  const dataDir = resolveDataDir(config)
  const projectsDir = path.join(dataDir, 'projects')
  ensure(projectsDir)

  const dirOf = (id) => path.join(projectsDir, id)

  function newId() {
    const t = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`
    return `${stamp}-${Math.random().toString(36).slice(2, 7)}`
  }

  function save(project) {
    project.updatedAt = Date.now()
    atomicWrite(path.join(dirOf(project.id), 'project.json'), JSON.stringify(project, null, 2))
    return project
  }

  function load(id) {
    const file = path.join(dirOf(id), 'project.json')
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  function create({ source, brief, title }) {
    const id = newId()
    const dir = dirOf(id)
    ensure(dir)
    ensure(path.join(dir, 'drafts'))
    ensure(path.join(dir, 'reports'))
    const project = {
      id,
      title: title || '未命名二创',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stage: 'input',
      round: 0,
      source: {
        text: source,
        wordCount: [...source].length,
      },
      brief,
      canon: null,
      diagnose: null,
      risks: [],
      decisions: [],
      drafts: [],
      audits: [],
      selectedDraftId: null,
      history: [],
      final: null,
      error: null,
    }
    atomicWrite(path.join(dir, 'source.txt'), source)
    return save(project)
  }

  function saveDraftFile(project, draft) {
    const dir = path.join(dirOf(project.id), 'drafts')
    ensure(dir)
    atomicWrite(path.join(dir, `${draft.id}.md`), draft.body || '')
  }

  function saveReport(project, round, report) {
    const dir = path.join(dirOf(project.id), 'reports')
    ensure(dir)
    atomicWrite(path.join(dir, `round-${round}.json`), JSON.stringify(report, null, 2))
  }

  function exportMarkdown(project, draft) {
    const brief = project.brief || {}
    const head = [
      `# ${draft.title || project.title}`,
      '',
      `> ${draft.logline || ''}`,
      '',
      `- 原作：${project.title}`,
      `- 方向：${brief.direction || 'sequel'}｜目标篇幅：${brief.targetWords || 3000} 字｜视角：${brief.pov === 'first' ? '第一人称' : '第三人称'}`,
      `- 生成：二创工坊（DeepSeek Harness 插件）· ${new Date().toISOString().slice(0, 10)}`,
      '',
      '---',
      '',
    ].join('\n')
    const audit = project.audits.find((a) => a.draftId === draft.id)
    const tail = audit
      ? [
          '',
          '---',
          '',
          '## 附：二创风险报告',
          '',
          `综合分：**${audit.overall}**（一致性 ${audit.scores.canon} / 人物 ${audit.scores.ooc} / 逻辑 ${audit.scores.logic} / 需求 ${audit.scores.coverage} / 合规 ${audit.scores.compliance} / 文笔 ${audit.scores.craft}）`,
          '',
          ...(audit.items || []).map((it) => `- [${it.severity}] ${it.message}`),
        ].join('\n')
      : ''
    const md = head + (draft.body || '') + tail
    const file = path.join(dirOf(project.id), 'export.md')
    atomicWrite(file, md)
    project.final = { draftId: draft.id, exportedPath: file, at: Date.now() }
    save(project)
    return { path: file, markdown: md }
  }

  function list() {
    return fs.readdirSync(projectsDir)
      .map((id) => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(projectsDir, id, 'project.json'), 'utf8'))
          return {
            id: p.id,
            title: p.title,
            stage: p.stage,
            round: p.round,
            updatedAt: p.updatedAt,
            words: p.source?.wordCount || 0,
            drafts: (p.drafts || []).length,
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  return { dataDir, create, load, save, saveDraftFile, saveReport, exportMarkdown, list, dirOf }
}
