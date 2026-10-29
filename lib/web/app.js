/* 二创工坊工作台 —— 无构建、无依赖的原生 ESM 前端。 */

const app = document.getElementById('app')
const stepsEl = document.getElementById('steps')
const badge = document.getElementById('model-badge')
const btnNew = document.getElementById('btn-new')
const dataDirEl = document.getElementById('data-dir')

const state = {
  health: null,
  project: null,
  view: 'loading',
  busy: false,
  stageDetail: '',
  progress: null,
  streaming: {},
  choices: {},
  notes: {},
  globalNote: '',
  sourceText: '',
  brief: {
    direction: 'sequel',
    targetWords: 3000,
    pov: 'third',
    style: '',
    taboos: '',
    extra: '',
    candidates: 3,
  },
  toastTimer: 0,
  startedAt: 0,
  elapsedTimer: 0,
  settings: null,
  settingsOpen: false,
  pendingKey: '',
  sourceName: '',
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const uid = () => Math.random().toString(36).slice(2, 9)

function toast(message, bad = false) {
  let el = document.querySelector('.toast')
  if (!el) {
    el = document.createElement('div')
    el.className = 'toast'
    document.body.appendChild(el)
  }
  el.textContent = message
  el.classList.toggle('bad', Boolean(bad))
  el.classList.add('show')
  clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 3200)
}

async function api(path, body, method = 'POST') {
  const res = await fetch(`/fanwork${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
  return data
}

/* ------------------------------------------------------------------ 路由 */

function setViewFromProject() {
  const p = state.project
  if (!p) return (state.view = 'input')
  if (['analyzing', 'diagnosing'].includes(p.stage)) return (state.view = 'progress')
  if (p.stage === 'risk_review') return (state.view = 'risk')
  if (['generating', 'auditing'].includes(p.stage)) return (state.view = 'progress')
  if (p.stage === 'candidate_review') return (state.view = 'candidates')
  if (['finalizing', 'done'].includes(p.stage)) return (state.view = 'final')
  return (state.view = 'input')
}

function markSteps() {
  const p = state.project
  const active = !p ? 'input'
    : ['analyzing', 'diagnosing', 'risk_review'].includes(p.stage) ? 'risk'
      : ['generating', 'auditing', 'candidate_review'].includes(p.stage) ? 'draft'
        : 'final'
  stepsEl.hidden = !p
  for (const step of stepsEl.querySelectorAll('.step')) {
    const order = ['input', 'risk', 'draft', 'final']
    step.classList.toggle('active', step.dataset.step === active)
    step.classList.toggle('done', order.indexOf(step.dataset.step) < order.indexOf(active))
  }
  btnNew.hidden = !p
}

function render() {
  markSteps()
  if (state.view === 'setup') renderSetup()
  else if (state.view === 'input') renderInput()
  else if (state.view === 'progress') renderProgress()
  else if (state.view === 'risk') renderRisk()
  else if (state.view === 'candidates') renderCandidates()
  else if (state.view === 'final') renderFinal()
  else renderLoading()
}

/* ---------------------------------------------------------- 0. 首次配置 */

function renderSetup() {
  const s = state.settings || {}
  app.innerHTML = `
    <section class="setup">
      <div class="setup-hero">
        <div class="setup-kicker">第 0 步 · 必须完成</div>
        <h1>配置你自己的 API</h1>
        <p>二创工坊不内置模型。所有生成都走你自己的接口，Key 只保存在本机。</p>
      </div>

      <div class="setup-card">
        <div class="setup-field">
          <label for="api-base">接口地址 <span class="req">必填</span></label>
          <input type="text" id="api-base" value="${esc(s.baseUrl || 'https://api.deepseek.com')}" placeholder="https://api.deepseek.com" />
        </div>
        <div class="setup-field">
          <label for="api-model">模型 <span class="req">必填</span></label>
          <input type="text" id="api-model" value="${esc(s.model || 'deepseek-chat')}" placeholder="deepseek-chat" />
        </div>
        <div class="setup-field">
          <label for="api-key">API Key <span class="req">必填</span></label>
          <input type="password" id="api-key" class="key-input" autocomplete="off" spellcheck="false"
                 placeholder="sk-..." value="${esc(state.pendingKey || '')}" />
          <div class="setup-hint">保存后只在本机读取，页面只显示掩码，日志不记录 Key。</div>
        </div>

        <div class="setup-actions">
          <button class="primary big" id="btn-save-settings">保存并开始 →</button>
          <button class="ghost" id="btn-test-api">测试连接</button>
          <span class="spacer"></span>
          <span class="muted" id="settings-status"></span>
        </div>
      </div>

      <ol class="setup-flow">
        <li class="on"><b>1</b>配置 API</li>
        <li><b>2</b>输入原文</li>
        <li><b>3</b>体检与生成</li>
      </ol>

      <p class="setup-foot">
        常见填法：DeepSeek 官方填 <code>https://api.deepseek.com</code> + <code>deepseek-chat</code>；
        其它 OpenAI 兼容网关把地址换成你自己的即可。
      </p>
    </section>
  `
}

function renderLoading() {
  app.innerHTML = '<section class="empty"><p>正在加载…</p></section>'
}

/* -------------------------------------------------------------- 1. 输入 */

const DIRECTIONS = [
  ['sequel', '续写'],
  ['side-story', '番外'],
  ['au', '平行 AU'],
  ['pov-switch', '视角切换'],
]

function renderInput() {
  const b = state.brief
  const s = state.settings || { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', hasKey: false, keyMask: '', configured: false }
  const busy = state.busy
  app.innerHTML = `
    <details class="api-bar" ${state.settingsOpen || !s.configured ? 'open' : ''}>
      <summary>
        <span class="api-dot ${s.configured ? 'ok' : 'bad'}"></span>
        <span class="api-title">API</span>
        <span class="api-model">${esc(s.model || '未配置')}</span>
        <span class="api-key">${s.hasKey ? esc(s.keyMask) : '未填写 Key'}</span>
        <span class="spacer"></span>
        <span class="api-edit">修改</span>
      </summary>
      <div class="settings-body">
        <div class="row">
          <div class="field">
            <label>接口地址</label>
            <input type="text" id="api-base" value="${esc(s.baseUrl || 'https://api.deepseek.com')}" placeholder="https://api.deepseek.com" />
          </div>
          <div class="field">
            <label>模型</label>
            <input type="text" id="api-model" value="${esc(s.model || 'deepseek-chat')}" placeholder="deepseek-chat" />
          </div>
        </div>
        <div class="field">
          <label>API Key ${s.hasKey ? `<span class="muted">（已保存 ${esc(s.keyMask)}，留空表示不修改）</span>` : ''}</label>
          <input type="password" id="api-key" autocomplete="off" placeholder="${s.hasKey ? '留空则沿用已保存的 Key' : 'sk-...'}" />
        </div>
        <div class="actions">
          <button class="primary" id="btn-save-settings">保存设置</button>
          <button class="ghost" id="btn-test-api">测试连接</button>
          ${s.hasKey ? '<button class="ghost" id="btn-clear-key">清除 Key</button>' : ''}
          <span class="spacer"></span>
          <span class="muted" id="settings-status"></span>
        </div>
      </div>
    </details>

    <div class="input-grid">
      <section class="card panel">
        <h2>① 原文</h2>
        <p class="hint">拖入 .txt / .md，或粘贴，或填本地路径。建议一次一章（≤ 8 万字）。</p>

        <div class="drop" id="drop">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5l5 5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <div><b>把 .txt / .md 拖到这里</b>，或 <button type="button" class="link" id="btn-pick">选择文件</button></div>
          <div class="muted" style="font-size:12px">文件只在本机读取，不会上传</div>
        </div>
        <input type="file" id="file-input" accept=".txt,.md,.markdown,.text" hidden />

        <div class="path-row">
          <input type="text" id="path-input" placeholder="或填本地路径：C:\\Users\\me\\story.txt" />
          <button class="ghost" id="btn-read-path" type="button">读取</button>
        </div>

        <textarea id="source" class="source" placeholder="把原文粘进来…&#10;&#10;例如：哈里・谢顿在川陀被捕的那一夜……">${esc(state.sourceText)}</textarea>
        <div class="meta-line">
          <span id="src-count">0 字</span>
          <span class="muted" id="src-origin">${esc(state.sourceName || '至少 50 字')}</span>
        </div>
      </section>

      <section class="card panel">
        <h2>② 创作要求</h2>
        <p class="hint">先想清楚要写什么，后面每一步都会拿它当尺子。</p>

        <div class="field">
          <label>方向</label>
          <div class="seg" data-seg="direction">
            ${DIRECTIONS.map(([k, label]) => `<button type="button" data-val="${k}" class="${b.direction === k ? 'on' : ''}">${label}</button>`).join('')}
          </div>
        </div>

        <div class="row">
          <div class="field">
            <label>目标篇幅（字）</label>
            <input type="number" id="target-words" min="500" max="8000" step="500" value="${b.targetWords}" />
          </div>
          <div class="field">
            <label>候选稿数量</label>
            <input type="number" id="candidate-count" min="1" max="4" value="${b.candidates}" />
          </div>
        </div>

        <div class="field">
          <label>视角</label>
          <div class="seg" data-seg="pov">
            <button type="button" data-val="third" class="${b.pov === 'third' ? 'on' : ''}">第三人称</button>
            <button type="button" data-val="first" class="${b.pov === 'first' ? 'on' : ''}">第一人称</button>
          </div>
        </div>

        <div class="field">
          <label>风格</label>
          <input type="text" id="style" placeholder="例如：克制冷静、冷幽默、古典译笔" value="${esc(b.style)}" />
        </div>

        <div class="field">
          <label>禁忌（用逗号分隔）</label>
          <input type="text" id="taboos" placeholder="例如：不要复活角色、不要加入新角色" value="${esc(b.taboos)}" />
        </div>

        <div class="field">
          <label>补充要求</label>
          <textarea id="extra" style="min-height:70px" placeholder="还有什么想说的？">${esc(b.extra)}</textarea>
        </div>

        <div class="actions">
          <button class="primary" id="btn-start" ${busy ? 'disabled' : ''}>开始体检 →</button>
          <span class="muted" id="start-hint">约 1–3 分钟</span>
        </div>
      </section>
    </div>
  `
  updateSourceCount()
  setupDrop()
}

function updateSourceCount() {
  const n = [...state.sourceText].length
  const el = document.getElementById('src-count')
  if (el) el.textContent = `${n} 字`
}

/* -------------------------------------------------------------- 2. 进度 */

function renderProgress() {
  const p = state.project
  const failed = !state.busy && p.error
  const detail = failed
    ? '这一步没有跑完'
    : (state.stageDetail
      || (p.stage === 'analyzing' ? '正在解析故事骨架…'
        : p.stage === 'diagnosing' ? '正在扫描逻辑漏洞…' : '正在生成…'))
  const preview = Object.values(state.streaming).join('')
  app.innerHTML = `
    <section class="card progress">
      ${failed ? `
        <div class="err-icon">!</div>
        <div class="detail" style="color:#8f2d2d;font-weight:600">${esc(p.error)}</div>
        <p class="hint" style="margin-top:6px">已完成的部分都保留着，可以直接重试这一步。</p>
        <div class="actions" style="justify-content:center">
          <button class="primary" id="btn-retry">重试这一步</button>
          <button class="ghost" id="btn-back">回到工作台</button>
        </div>
      ` : `
        <div class="spinner"></div>
        <div class="detail">${esc(detail)}</div>
        <div class="pct">
          ${state.progress ? `${state.progress.done} / ${state.progress.total} · ` : ''}
          <span id="elapsed">0s</span>
        </div>
        ${preview ? `<div class="stream-preview">${esc(preview.slice(-1200))}</div>` : ''}
        <div class="actions" style="justify-content:center">
          <button class="ghost" id="btn-cancel">取消</button>
        </div>
      `}
    </section>
  `
  if (failed) return
  clearInterval(state.elapsedTimer)
  state.elapsedTimer = setInterval(() => {
    const el = document.getElementById('elapsed')
    if (!el) { clearInterval(state.elapsedTimer); return }
    el.textContent = `${Math.round((Date.now() - state.startedAt) / 1000)}s`
  }, 1000)
}

/* -------------------------------------------------------------- 3. 体检 */

const STAGE_NAMES = { risk_review: '待裁决', candidate_review: '待选稿', done: '已定稿' }

function severityCounts(risks) {
  const c = { P0: 0, P1: 0, P2: 0 }
  for (const r of risks || []) c[r.severity] = (c[r.severity] || 0) + 1
  return c
}

function renderRisk() {
  const p = state.project
  const risks = p.risks || []
  const { P0, P1, P2 } = severityCounts(risks)
  const health = p.diagnose?.health
  app.innerHTML = `
    <section class="card panel">
      <div class="risk-head">
        <div>
          <h2>原文体检</h2>
          <p class="hint">${esc(p.diagnose?.summary || '已生成风险报告')}</p>
          <div class="meta-line">
            <span class="tag P0">高危 ${P0}</span>
            <span class="tag P1">中危 ${P1}</span>
            <span class="tag P2">低危 ${P2}</span>
            <span class="muted">共 ${risks.length} 条</span>
          </div>
        </div>
        ${Number.isFinite(health) ? `<div class="health"><b>${health}</b><span>/ 100 健康度</span></div>` : ''}
      </div>

      ${risks.length ? `<div class="risk-list">${risks.map(riskCard).join('')}</div>`
        : '<p class="muted">没有发现明显的逻辑问题。可以直接生成。</p>'}

      <div class="actions">
        <button class="primary" id="btn-decide">应用裁决并生成 →</button>
        <button class="ghost" id="btn-skip">全部接受，直接生成</button>
        <span class="spacer"></span>
        <span class="muted">选中 0 条</span>
      </div>
    </section>
  `
  updateDecisionCount()
}

function riskCard(r, idx) {
  const chosen = state.choices[r.id]
  const note = state.notes[r.id] || ''
  const evidence = (r.evidence || []).map((e) => `<div class="evidence">第 ${e.paragraph ?? '?'} 段：<q>${esc(e.quote)}</q></div>`).join('')
  return `
    <article class="risk ${chosen || note ? 'decided' : ''}" data-risk="${esc(r.id)}">
      <div class="risk-top">
        <span class="tag">${esc(r.id)}</span>
        <span class="tag">${esc(r.category)}</span>
        <span class="tag ${esc(r.severity)}">${esc(r.severity)}</span>
        ${chosen ? '<span class="tag" style="background:#e7eeff;color:#3550e6">已选方案</span>' : ''}
        ${note && !chosen ? '<span class="tag" style="background:#fff4e0;color:#b7791f">自定义要求</span>' : ''}
      </div>
      <div class="risk-title">${idx + 1}. ${esc(r.title)}</div>
      <div class="risk-reason">${esc(r.reasoning)}</div>
      ${evidence}
      <div class="options">
        ${(r.fixes || []).map((f) => `
          <label class="opt ${chosen === f.id ? 'on' : ''}">
            <input type="radio" name="risk:${esc(r.id)}" value="${esc(f.id)}" ${chosen === f.id ? 'checked' : ''} />
            <span class="opt-body">
              <span class="opt-title">
                ${esc(f.id)} ${esc(f.label)}
                <span class="cost">${'★'.repeat(f.cost)}${'☆'.repeat(3 - f.cost)}</span>
                ${r.recommended === f.id ? '<span class="tag" style="background:#e8f5ee;color:#2f855a">推荐</span>' : ''}
              </span>
              <span class="opt-desc">${esc(f.description)}
                · 波及 ${f.blastRadius} 段${f.sideEffects?.length ? ` · 可能引入 ${f.sideEffects.join('、')}` : ''}
              </span>
            </span>
          </label>`).join('')}
      </div>
      <details class="more" ${note ? 'open' : ''}>
        <summary>更多要求（不选方案时，直接写下你想怎么改）</summary>
        <textarea data-note-for="${esc(r.id)}" placeholder="例如：不要让林夏失忆，改成她假装失忆，留到结尾再揭穿">${esc(note)}</textarea>
      </details>
    </article>
  `
}

function updateDecisionCount() {
  const n = Object.keys(state.choices).length + Object.values(state.notes).filter((v) => v.trim()).length
  const el = document.querySelector('.actions .muted:last-child')
  if (el) el.textContent = `选中 ${n} 条`
}

/* -------------------------------------------------------------- 4. 候选 */

function renderCandidates() {
  const p = state.project
  const drafts = p.drafts || []
  const auditOf = (id) => (p.audits || []).find((a) => a.draftId === id)
  app.innerHTML = `
    <section class="card panel" style="margin-bottom:14px">
      <div class="risk-head">
        <div>
          <h2>候选稿</h2>
          <p class="hint">每稿自带体检报告；挑一稿定稿，或继续提要求换一批。</p>
        </div>
        <div class="meta-line">
          <span class="muted">第 ${p.round} 轮</span>
        </div>
      </div>
      <div class="draft-grid">
        ${drafts.map((d) => draftCard(d, auditOf(d.id))).join('') || '<p class="muted">还没有稿件</p>'}
      </div>
    </section>

    <section class="card panel">
      <h2>更多要求</h2>
      <p class="hint">不满意就继续提，系统会带着你的裁决重新生成一批。</p>
      <textarea id="global-note" style="min-height:70px" placeholder="例如：结尾留白，不要解释太多；减少心理描写">${esc(state.globalNote)}</textarea>
      <div class="actions">
        <button class="ghost" id="btn-regenerate">按新要求换一批</button>
        <span class="spacer"></span>
        <span class="muted">点击卡片的「采用此稿」即可定稿</span>
      </div>
    </section>
  `
  paintStreaming()
}

function draftCard(d, audit) {
  const scores = audit?.scores
  return `
    <article class="card draft" data-draft="${esc(d.id)}">
      <header>
        <h3>${esc(d.title || '生成中…')}</h3>
        <div class="logline">${esc(d.angle || '')}${d.logline ? ' · ' + esc(d.logline) : ''}</div>
      </header>
      <div class="body" data-body="${esc(d.id)}">${esc(d.body || '')}</div>
      <footer>
        ${audit ? `<span class="score">${audit.overall}<small> 综合</small></span>
          <span class="muted" style="font-size:11px">一致 ${scores.canon} · 人物 ${scores.ooc} · 逻辑 ${scores.logic}</span>` : '<span class="muted">审核中…</span>'}
        <span class="spacer" style="flex:1"></span>
        <button class="primary" data-select="${esc(d.id)}">采用此稿</button>
      </footer>
      ${audit?.items?.length ? `<ul class="audit-list">${audit.items.slice(0, 3).map((it) => `<li>[${esc(it.severity)}] ${esc(it.message)}</li>`).join('')}</ul>` : ''}
    </article>
  `
}

function paintStreaming() {
  for (const [id, text] of Object.entries(state.streaming)) {
    const el = document.querySelector(`[data-body="${CSS.escape(id)}"]`)
    if (el) el.textContent = text
  }
}

/* -------------------------------------------------------------- 5. 定稿 */

function renderFinal() {
  const p = state.project
  const draft = (p.drafts || []).find((d) => d.id === p.selectedDraftId)
  const audit = (p.audits || []).find((a) => a.draftId === p.selectedDraftId)
  app.innerHTML = `
    <section class="card final-box">
      <h2>已定稿：${esc(draft?.title || p.title)}</h2>
      <p class="hint">${esc(draft?.logline || '')}</p>
      ${audit ? `<div class="meta-line">
        <span class="tag">综合 ${audit.overall}</span>
        <span class="muted">一致性 ${audit.scores.canon} · 人物 ${audit.scores.ooc} · 逻辑 ${audit.scores.logic} · 需求 ${audit.scores.coverage} · 合规 ${audit.scores.compliance} · 文笔 ${audit.scores.craft}</span>
      </div>` : ''}
      <div class="mt">
        <div class="muted" style="font-size:12px;margin-bottom:6px">导出文件</div>
        <div class="path">${esc(p.final?.exportedPath || '（未导出）')}</div>
      </div>
      <div class="actions">
        <button class="primary" id="btn-copy-path">复制路径</button>
        <button class="ghost" id="btn-preview">预览全文</button>
        <button class="ghost" id="btn-new-2">新建项目</button>
      </div>
      <div class="mt"><div class="notice">提醒：二创请确认你有原文的使用权；导出文件已附带原作信息与二创声明。</div></div>
    </section>
    <section class="card panel mt" id="preview-box" hidden>
      <h2>正文预览</h2>
      <div class="stream-preview" style="max-height:420px">${esc(draft?.body || '')}</div>
    </section>
  `
}

/* -------------------------------------------------------------- SSE 执行 */

async function runStage(stage) {
  const p = state.project
  if (!p) return
  state.busy = true
  state.streaming = {}
  state.stageDetail = stage === 'analyze' ? '正在解析故事骨架…' : '正在生成候选稿…'
  state.startedAt = Date.now()
  state.project.error = null
  if (stage === 'analyze') {
    state.project.stage = 'analyzing'
  } else {
    state.project.stage = 'generating'
    state.project.drafts = []
    state.project.audits = []
  }
  state.view = 'progress'
  render()

  try {
    const res = await fetch(`/fanwork/api/projects/${p.id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage }),
    })
    if (!res.ok || !res.body) throw new Error(`执行失败（${res.status}）`)
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
          try {
            handleEvent(JSON.parse(line.slice(6)))
          } catch { /* 忽略半包 */ }
        }
      }
    }
  } catch (err) {
    state.project.error = err.message
    toast(err.message, true)
  } finally {
    state.busy = false
    clearInterval(state.elapsedTimer)
    setViewFromProject()
    render()
  }
}

function handleEvent(ev) {
  const p = state.project
  switch (ev.type) {
    case 'stage':
      state.stageDetail = ev.detail || ev.stage
      state.progress = null
      if (state.view === 'progress') render()
      break
    case 'progress':
      state.progress = { done: ev.done, total: ev.total }
      if (state.view === 'progress') render()
      break
    case 'canon':
      p.canon = ev.canon
      if (ev.canon?.title && p.title === '未命名二创') p.title = ev.canon.title
      break
    case 'diagnose':
      p.risks = ev.risks || []
      p.diagnose = { summary: ev.summary, health: ev.health }
      break
    case 'delta': {
      const prev = state.streaming[ev.draftId] || ''
      state.streaming[ev.draftId] = prev + (ev.text || '')
      const el = document.querySelector(`[data-body="${CSS.escape(ev.draftId)}"]`)
      if (el) el.textContent = state.streaming[ev.draftId]
      else if (state.view === 'progress') render()
      break
    }
    case 'draft':
      p.drafts = [...(p.drafts || []).filter((d) => d.id !== ev.draft.id), ev.draft]
      if (state.view === 'progress') { setViewFromProject(); render() }
      else render()
      break
    case 'audit':
      p.audits = [...(p.audits || []).filter((a) => a.draftId !== ev.audit.draftId), ev.audit]
      if (state.view === 'candidates') render()
      break
    case 'decisions':
      p.decisions = ev.decisions
      break
    case 'done':
      state.project = { ...p, ...ev.project, error: null }
      state.streaming = {}
      setViewFromProject()
      render()
      break
    case 'error':
      if (ev.aborted) {
        state.project.error = '已取消'
      } else {
        state.project.error = ev.message || '出错了'
      }
      if (state.view === 'progress') render()
      else toast(ev.message || '出错了', true)
      break
    default:
      break
  }
}

/* -------------------------------------------------------------- 事件绑定 */

app.addEventListener('input', (e) => {
  const t = e.target
  if (t.id === 'source') { state.sourceText = t.value; state.sourceName = ''; updateSourceCount() }
  else if (t.id === 'api-key') state.pendingKey = t.value
  else if (t.id === 'target-words') state.brief.targetWords = Number(t.value) || 3000
  else if (t.id === 'candidate-count') state.brief.candidates = Math.min(4, Math.max(1, Number(t.value) || 3))
  else if (t.id === 'style') state.brief.style = t.value
  else if (t.id === 'taboos') state.brief.taboos = t.value
  else if (t.id === 'extra') state.brief.extra = t.value
  else if (t.id === 'global-note') state.globalNote = t.value
  else if (t.dataset.noteFor) {
    state.notes[t.dataset.noteFor] = t.value
    const card = t.closest('.risk')
    card?.classList.toggle('decided', Boolean(t.value.trim()) || Boolean(state.choices[t.dataset.noteFor]))
    updateDecisionCount()
  }
})

app.addEventListener('change', (e) => {
  const t = e.target
  if (t.id === 'file-input') {
    const file = t.files?.[0]
    if (file) loadFile(file)
    return
  }
  if (t.type === 'radio' && t.name?.startsWith('risk:')) {
    const riskId = t.name.slice(5)
    state.choices[riskId] = t.value
    const card = t.closest('.risk')
    card?.querySelectorAll('.opt').forEach((o) => o.classList.toggle('on', o.querySelector('input').checked))
    card?.classList.add('decided')
    if (state.notes[riskId]) state.notes[riskId] = ''
    const ta = card?.querySelector('textarea')
    if (ta) ta.value = ''
    updateDecisionCount()
  }
})

app.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-select]')
  if (!t) return

  if (t.dataset.seg) return
  if (t.closest('.seg') && t.dataset.val) {
    const seg = t.closest('.seg')
    const key = seg.dataset.seg
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b === t)
    if (key === 'mode') {
      state.settings = { ...(state.settings || {}), mode: t.dataset.val }
      state.settingsOpen = true
      renderInput()
      return
    }
    state.brief[key] = t.dataset.val
    return
  }

  if (t.id === 'btn-pick') {
    document.getElementById('file-input')?.click()
    return
  }

  if (t.id === 'btn-read-path') {
    const p = document.getElementById('path-input')?.value?.trim()
    if (!p) return toast('先填一个本地路径', true)
    try {
      const file = await api('/api/read-file', { path: p })
      state.sourceText = file.text
      state.sourceName = `${file.name} · ${file.chars} 字`
      renderInput()
      toast(`已读取 ${file.name}`)
    } catch (err) {
      toast(err.message, true)
    }
    return
  }

  if (t.id === 'btn-save-settings') {
    await saveSettings()
    return
  }

  if (t.id === 'btn-test-api') {
    const status = document.getElementById('settings-status')
    await saveSettings({ silent: true })
    if (status) status.textContent = '测试中…'
    try {
      const out = await api('/api/settings/test', {})
      const text = out.ok ? `可用 · ${out.ms}ms · ${out.sample || ''}` : `失败：${out.error}`
      if (status) status.textContent = text
      toast(out.ok ? '连接正常' : `连接失败：${out.error}`, !out.ok)
    } catch (err) {
      if (status) status.textContent = err.message
    }
    return
  }

  if (t.id === 'btn-clear-key') {
    try {
      await api('/api/settings', { apiKey: '' })
      await refreshHealth()
      if (!state.settings?.configured) {
        state.view = 'setup'
        render()
      } else {
        renderInput()
      }
      toast('已清除 API Key')
    } catch (err) {
      toast(err.message, true)
    }
    return
  }

  if (t.id === 'btn-start') {
    if (!state.settings?.configured) {
      state.view = 'setup'
      render()
      return toast('先配置 API Key', true)
    }
    if ([...state.sourceText].length < 50) return toast('原文太短，至少 50 字', true)
    t.disabled = true
    try {
      const { project } = await api('/api/projects', {
        source: state.sourceText,
        title: state.project?.title || '',
        brief: state.brief,
      })
      state.project = project
      localStorage.setItem('fanwork:last', project.id)
      state.choices = {}
      state.notes = {}
      state.globalNote = ''
      await runStage('analyze')
    } catch (err) {
      toast(err.message, true)
      t.disabled = false
    }
    return
  }

  if (t.id === 'btn-retry') {
    const stage = ['generating', 'auditing'].includes(state.project.stage) ? 'generate' : 'analyze'
    await runStage(stage)
    return
  }

  if (t.id === 'btn-back') {
    const p = state.project
    if ((p.risks || []).length) state.view = 'risk'
    else if ((p.drafts || []).length) state.view = 'candidates'
    else state.view = 'input'
    render()
    return
  }

  if (t.id === 'btn-cancel') {
    if (state.project) api(`/api/projects/${state.project.id}/cancel`).catch(() => {})
    return
  }

  if (t.id === 'btn-decide' || t.id === 'btn-skip') {
    const decisions = []
    if (t.id === 'btn-decide') {
      for (const risk of state.project.risks || []) {
        const opt = state.choices[risk.id]
        if (opt) decisions.push({ riskId: risk.id, optionId: opt })
        else if ((state.notes[risk.id] || '').trim()) decisions.push({ riskId: risk.id, text: state.notes[risk.id].trim() })
      }
    }
    try {
      if (decisions.length) {
        const { project } = await api(`/api/projects/${state.project.id}/decisions`, { decisions })
        state.project = project
      }
      await runStage('generate')
    } catch (err) {
      toast(err.message, true)
    }
    return
  }

  if (t.dataset.select) {
    t.disabled = true
    try {
      const { project } = await api(`/api/projects/${state.project.id}/select`, { draftId: t.dataset.select })
      state.project = project
      setViewFromProject()
      render()
      toast('已定稿并导出')
    } catch (err) {
      toast(err.message, true)
      t.disabled = false
    }
    return
  }

  if (t.id === 'btn-regenerate') {
    try {
      if (state.globalNote.trim()) {
        const { project } = await api(`/api/projects/${state.project.id}/decisions`, {
          decisions: [{ text: state.globalNote.trim() }],
        })
        state.project = project
        state.globalNote = ''
      }
      await runStage('regate')
    } catch (err) {
      toast(err.message, true)
    }
    return
  }

  if (t.id === 'btn-copy-path') {
    const path = state.project?.final?.exportedPath || ''
    navigator.clipboard?.writeText(path).then(() => toast('路径已复制'), () => toast('复制失败，请手动选中', true))
    return
  }

  if (t.id === 'btn-preview') {
    const box = document.getElementById('preview-box')
    if (box) box.hidden = !box.hidden
    return
  }

  if (t.id === 'btn-new' || t.id === 'btn-new-2') {
    localStorage.removeItem('fanwork:last')
    state.project = null
    state.sourceText = ''
    state.streaming = {}
    state.choices = {}
    state.notes = {}
    state.globalNote = ''
    state.view = 'input'
    render()
  }
})

async function refreshHealth() {
  try {
    const health = await api('/api/health', undefined, 'GET')
    state.health = health
    state.settings = health.settings || state.settings
    const configured = Boolean(health.settings?.configured)
    badge.textContent = configured ? `API · ${health.model}` : '未配置 API'
    badge.classList.toggle('ok', configured)
    badge.classList.toggle('bad', !configured)
    dataDirEl.textContent = health.dataDir
  } catch {
    badge.textContent = '未连接'
    badge.classList.add('bad')
  }
}

/* ------------------------------------------------------------ 文件载入 */

async function loadFile(file) {
  if (!file) return
  if (file.size > 4 * 1024 * 1024) return toast('文件超过 4 MB，建议先分卷', true)
  if (!/\.(txt|md|markdown|text)$/i.test(file.name)) return toast('只支持 .txt / .md 文件', true)
  try {
    const text = (await file.text()).replace(/^\uFEFF/, '')
    state.sourceText = text
    state.sourceName = `${file.name} · ${[...text].length} 字`
    renderInput()
    toast(`已载入 ${file.name}`)
  } catch (err) {
    toast(`读取失败：${err.message}`, true)
  }
}

function setupDrop() {
  const drop = document.getElementById('drop')
  if (!drop) return
  const panel = drop.closest('.panel')
  const enter = (e) => {
    e.preventDefault()
    drop.classList.add('over')
  }
  const leave = (e) => {
    e.preventDefault()
    if (!drop.contains(e.relatedTarget)) drop.classList.remove('over')
  }
  const handleDrop = (e) => {
    e.preventDefault()
    drop.classList.remove('over')
    const file = e.dataTransfer?.files?.[0]
    if (file) loadFile(file)
  }
  for (const el of [drop, panel]) {
    if (!el) continue
    el.addEventListener('dragover', enter)
    el.addEventListener('dragleave', leave)
    el.addEventListener('drop', handleDrop)
  }
}

async function saveSettings({ silent = false } = {}) {
  const val = (id) => document.getElementById(id)?.value?.trim() || ''
  const baseUrl = val('api-base')
  const model = val('api-model')
  const key = state.pendingKey || val('api-key')
  if (!baseUrl || !model) return toast('接口地址和模型都不能为空', true)
  if (!key && !state.settings?.hasKey) return toast('请填写 API Key', true)

  const body = { baseUrl, model }
  if (key) body.apiKey = key

  try {
    const view = await api('/api/settings', body)
    state.settings = view
    state.pendingKey = ''
    await refreshHealth()
    if (!silent) {
      if (view.configured) {
        toast(`已保存（${view.model}）`)
        if (state.view === 'setup') {
          state.view = 'input'
          render()
        } else {
          renderInput()
        }
      } else {
        toast('还没配置完成：请填写 API Key', true)
      }
    }
    return view
  } catch (err) {
    toast(err.message, true)
    return null
  }
}

/* -------------------------------------------------------------- 启动 */

async function boot() {
  await refreshHealth()

  // 没配置 API 就先停在配置页，别的什么都不给点
  if (!state.settings?.configured) {
    state.view = 'setup'
    render()
    return
  }

  const last = localStorage.getItem('fanwork:last')
  if (last) {
    try {
      const { project } = await api(`/api/projects/${last}`, undefined, 'GET')
      state.project = project
      setViewFromProject()
      render()
      return
    } catch {
      localStorage.removeItem('fanwork:last')
    }
  }
  state.view = 'input'
  render()
}

boot()
