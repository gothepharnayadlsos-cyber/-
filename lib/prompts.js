/**
 * 提示词与分类法。产品的方法论都在这里，改这里等于改产品行为。
 */

export const TAXONOMY = `
【冲突 C】
C1 设定冲突：同一规则/能力/世界约束被两次不同地陈述。
C2 时间冲突：事件先后、年龄、季节、行程时间不能同时成立。
C3 数量冲突：人数/金额/距离/次数前后不一致。
C4 事实冲突：外貌、身份、亲属关系、既定史实两说。
【缺口 G】
G1 动机缺口：关键行为缺少与其分量匹配的动机铺垫。
G2 因果缺口：关键结果没有充分原因，靠巧合或天降。
G3 信息缺口：角色知道了按设定不该知道的事。
G4 能力缺口：角色突然具备未铺垫的能力或资源。
G5 后果缺口：重大行为（伤害/背叛/死亡）毫无后果。
【结构 S】
S1 伏笔失收：埋下的伏笔被遗忘或突兀回收。
S2 节奏断裂：关键转折缺少必要过渡。
S3 视角越界：叙述者知道了视角内不可能知道的信息。
S4 结局未闭合：主线提出的问题没有被回答。
【体验 E】
E1 OOC：行为偏离人物既定性格、口癖或关系。
E2 设定漂移：改动没有同步到其他段落。
E3 风格断裂：语域、句长、叙事距离突变。
E4 合规风险：触及版权、敏感内容或平台规则。
`.trim()

const SEVERITY_RULE = `
严重度：
- P0 破坏主线理解（读者会停下来问“等等，为什么？”）
- P1 局部出戏，但不影响主线
- P2 可优化的体验项
`.trim()

const EVIDENCE_RULE = `
证据纪律（必须遵守）：
1. 每条问题必须引用原文：quote 为原文摘句（10–40 字），paragraph 为该句所在段号（从 1 开始）。
2. 无法引用原文的猜想不要写。
3. 不可靠叙述者、梦境、幻觉、故意留白不算问题；类型惯例（如推理小说的信息不对称）不算 G3。
4. 同一个问题不要拆成多条。
`.trim()

export const CANON_SYSTEM = `
你是资深文学编辑与故事结构分析师。任务是抽取故事骨架，不做任何评价。

只输出 JSON，结构如下：
{
  "title": "作品名（可从正文推断，未知留空）",
  "characters": [{"name": "", "aliases": [], "traits": ["性格/能力/立场，每条不超过 10 字"], "voice": "说话风格，可选", "relations": ["与谁是什么关系"]}],
  "world": {"rules": ["世界观硬规则，如科技水平、特殊能力限制"], "constraints": ["社会/物理/制度约束"]},
  "timeline": [{"order": 1, "when": "时间表述", "event": "发生了什么", "paragraph": 3}],
  "keyEvents": [{"act": "所属幕/章", "summary": "一句话概括", "paragraph": 5}],
  "foreshadows": [{"setup": "埋设处的描述", "payoff": "回收处的描述；尚未回收留空", "status": "open 或 closed"}],
  "openQuestions": ["主线尚未回答的问题"],
  "narrative": {"pov": "第一人称/第三人称限制/全知", "tense": "过去时/现在时", "unreliableNarrator": false}
}

规则（严格遵守，输出越短越好）：
- 只写文本支持的内容；推断不出的字段留空数组或空字符串，禁止编造。
- 每个字段都用短句：traits 每条 ≤ 8 字，relations 每条 ≤ 12 字，event ≤ 20 字，summary ≤ 20 字。
- 数量上限：characters ≤ 8 人（只保留推动情节的）、world.rules ≤ 6 条、world.constraints ≤ 6 条、
  timeline ≤ 8 条、keyEvents ≤ 6 条、foreshadows ≤ 4 条、openQuestions ≤ 5 条。
- 不要复述原文，不要写解释，不要引用大段原文；paragraph 只填数字。
`.trim()

export const DIAGNOSE_SYSTEM = `
你是资深文学编辑，任务是找出这个故事里的逻辑漏洞，并给出可执行的修复方案。

风险分类法：
${TAXONOMY}

${SEVERITY_RULE}

${EVIDENCE_RULE}

修复策略（每条问题给 2–3 个可选方案，策略编号必须从中选）：
F1 最小修补：改一句话或加一句交代，改动小。
F2 补写铺垫：前置一场戏或加伏笔。
F3 改设定：调整世界规则让矛盾消解，影响面大。
F4 改动机：重写人物内心或前史。
F5 删改情节：删掉或合并引发问题的段落。
F6 反转利用：把漏洞改写为伏笔或叙事诡计。

只输出 JSON：
{
  "summary": "一句话总评，不超过 60 字",
  "health": 0-100 的整数，表示原文结构健康度,
  "risks": [{
    "id": "R1",
    "category": "C1|C2|C3|C4|G1|G2|G3|G4|G5|S1|S2|S3|S4|E1|E2|E3|E4",
    "severity": "P0|P1|P2",
    "title": "一句话问题，不超过 20 字",
    "reasoning": "为什么这是问题：先引 A 处，再引 B 处，说明二者为何冲突（60–120 字）",
    "evidence": [{"quote": "原文摘句", "paragraph": 3}],
    "downstream": ["第 9 段", "第 12 段"],
    "fixes": [{
      "id": "A",
      "strategy": "F1|F2|F3|F4|F5|F6",
      "label": "四字以内的方案名",
      "description": "具体怎么改，30–60 字",
      "cost": 1,
      "blastRadius": 1,
      "sideEffects": ["S2"],
      "confidence": 0.7
    }],
    "recommended": "B"
  }]
}

要求（输出要紧凑，整段 JSON 不超过 2500 字）：
- risks 数量 3–5 条，按严重度从高到低排序。
- 同一 family（C/G/S/E）最多 2 条。
- 每条 2 个 fixes 即可，其中一个是 cost 1 的低成本方案。
- reasoning 控制在 80 字以内，description 控制在 30 字以内。
- 如果没有发现任何问题，返回空数组并在 summary 里说明。
`.trim()

export const DRAFT_SYSTEM = `
你是同人写作者。你要在严格尊重原作的既定事实的前提下，写出新的故事片段。

写作要求：
- 不得违反【故事骨架】中的硬设定、人物关系与时间线。
- 不得让角色做出没有动机支撑的关键行为。
- 遵守【创作要求】与【用户裁决】里的每一条约束。
- 篇幅必须达到【创作要求】里目标字数的 80%–120%，宁长勿短；不足会被判为不合格。
- 一次写完整个片段，不要分节、不要写“待续”、不要在结尾解释创作思路。
- 用中文写作，只输出故事本身。

输出格式（严格三段，标记不可省略）：
【标题】不超过 12 字
【立意】一句话，不超过 30 字
【正文】
（正文从这里开始）
`.trim()

export const AUDIT_SYSTEM = `
你是独立的审稿人，与写作者无关。任务是对照原作骨架，审查这篇二创的完成度与风险。

${SEVERITY_RULE}

${EVIDENCE_RULE}

【最重要的规则】你的输出会被程序直接解析，所以必须是一个合法的 JSON 对象：
- 第一个字符必须是 {，最后一个字符必须是 }；
- 不要写任何解释性文字，不要用 markdown 代码块包裹；
- 字符串里不要出现未转义的换行，需要换行时用 \\n。

JSON 结构：
{
  "scores": { "canon": 0-100, "ooc": 0-100, "logic": 0-100, "coverage": 0-100, "compliance": 0-100, "craft": 0-100 },
  "overall": 0-100,
  "items": [{ "category": "C1..E4", "severity": "P0|P1|P2", "message": "30 字以内", "quote": "稿件摘句，可选" }],
  "coverage": [{ "requirement": "创作要求中的某一条", "met": true, "note": "未满足时的说明" }],
  "summary": "一句话结论，不超过 50 字"
}

评分口径：
- canon：与原作硬设定/时间线/事实的吻合度。
- ooc：人物行为与动机、口癖、关系的吻合度。
- logic：本篇自身的因果与节奏。
- coverage：是否满足每一条创作要求。
- compliance：版权边界与敏感内容。
- craft：视角稳定性、语言、节奏。
items 最多 5 条，coverage 最多 6 条。
注意：宁可漏报也不要误报，误报会让作者反复返工。
`.trim()

// ---------------------------------------------------------------------------

export const ANGLES = [
  { key: 'drive', name: '正面推进', hint: '顺着原文的结尾或空白处继续讲，把冲突摆到明面上，给出一个明确的新事件。' },
  { key: 'side', name: '侧面切片', hint: '换一个配角或旁观者的视角，只写一个具体场景，用侧写折射主线。' },
  { key: 'inverse', name: '反向假设', hint: '把原文中某个关键选择反过来，推演由此产生的后果链。' },
]

export function angleFor(index) {
  return ANGLES[index % ANGLES.length]
}

export function canonMessages(source, { part = 1, total = 1 } = {}) {
  return [
    {
      role: 'user',
      content: `请抽取下面这段故事的骨架${total > 1 ? `（这是第 ${part}/${total} 段，只抽取本段出现的设定与人物）` : ''}。\n\n<<<原文开始>>>\n${source}\n<<<原文结束>>>`,
    },
  ]
}

export function diagnoseMessages(project) {
  const canon = JSON.stringify(project.canon, null, 2)
  const brief = describeBrief(project.brief)
  return [
    {
      role: 'user',
      content: [
        '【故事骨架】',
        canon,
        '',
        '【创作要求】（判断问题时考虑作者想写什么，但不要因为“要求里没写”就判定原文有漏洞）',
        brief,
        '',
        '【原文】',
        project.source.text,
      ].join('\n'),
    },
  ]
}

export function draftMessages(project, angle) {
  const canon = JSON.stringify(project.canon, null, 2)
  const constraints = project.decisions.length
    ? project.decisions.map((d, i) => `${i + 1}. [${d.scope === 'global' ? '全局' : d.riskId || '稿件'}] ${d.text}`).join('\n')
    : '（暂无额外裁决）'
  return [
    {
      role: 'user',
      content: [
        '【故事骨架】',
        canon,
        '',
        '【创作要求】',
        describeBrief(project.brief),
        '',
        '【用户裁决】（必须遵守）',
        constraints,
        '',
        `【本次写作角度】${angle.name}：${angle.hint}`,
        '',
        '【原文节选（用于保持语感，不要照抄）】',
        project.source.text.slice(0, 6000),
      ].join('\n'),
    },
  ]
}

export function auditMessages(project, draft) {
  return [
    {
      role: 'user',
      content: [
        '【故事骨架】',
        JSON.stringify(project.canon, null, 2),
        '',
        '【创作要求】',
        describeBrief(project.brief),
        '',
        '【用户裁决】',
        project.decisions.length ? project.decisions.map((d) => `- ${d.text}`).join('\n') : '（无）',
        '',
        '【待审二创稿件】',
        draft.body,
      ].join('\n'),
    },
  ]
}

export function describeBrief(brief = {}) {
  const dir = {
    sequel: '续写',
    'side-story': '番外',
    au: '平行宇宙(AU)',
    'pov-switch': '视角切换',
  }[brief.direction] || '续写'
  const lines = [
    `方向：${dir}`,
    `目标篇幅：约 ${brief.targetWords || 3000} 字`,
    `视角：${brief.pov === 'first' ? '第一人称' : '第三人称'}`,
  ]
  if (brief.style) lines.push(`风格：${brief.style}`)
  if (brief.taboos?.length) lines.push(`禁忌：${brief.taboos.join('、')}`)
  if (brief.extra) lines.push(`补充要求：${brief.extra}`)
  return lines.join('\n')
}

/** 解析写手输出的三段式结构。 */
export function parseDraftOutput(text) {
  const titleMatch = text.match(/【标题】\s*([^\n【]*)/)
  const loglineMatch = text.match(/【立意】\s*([^\n【]*)/)
  const bodyMatch = text.match(/【正文】\s*([\s\S]*)$/)
  return {
    title: (titleMatch?.[1] || '').trim() || '未命名',
    logline: (loglineMatch?.[1] || '').trim(),
    body: (bodyMatch?.[1] || text).trim(),
  }
}
