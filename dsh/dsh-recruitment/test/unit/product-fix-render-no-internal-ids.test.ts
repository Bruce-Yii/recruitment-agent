// 机检：**所有** `src/tools/*.ts` 工具的 render 文本里不许出现内部编号（完整 UUID / 完整 64hex）。
//
// 病根（O1 残留，产品负责人 2026-11-16 判定）：DSH 自己的工具不会把内部编号念给用户；
// 是**我们注册工具时**在 render（模型读到的那段文字）里塞了完整 UUID / 64hex，模型照着念给 HR。
// 上一轮（HEAD `78b12ae`）只修了 `business-read.ts` 的两个工具，其余工具的 render 仍是
// `job_id=<UUID>` / `application_id=<UUID>` / `sha256=<64hex>` / `query: {...JSON...}`，
// 模型会原样写进答复。这不再是"文案问题"，而是**我们自己工程师的低级错误**，所以必须机检，
// 不能靠记性。
//
// 本检查怎么做（**执行 render，不扫源码**）：
//   1. 枚举 `src/tools/*.ts` 里所有工具工厂（`create*` / `unconfigured*`），用**假配置**造出工具；
//      —— 覆盖守卫：新增一个工具文件 / 工厂而没被本检查执行，则本测试红。
//   2. 用工具自己声明的 `output.schema` **合成**一份"每个 id 都是完整 UUID、每个 hash 都是完整
//      64hex"的规范值（full 变体 + sparse 变体），真的调用 `output.render(args, value)`；
//   3. 断言 render 文本里没有完整 UUID / 完整 64hex / 32+ 连续 hex（若有，逐条指出工具+行号+命中）。
//
// 白名单与理由（逐条）：
//   * 短号：UUID 末 4 位 `…0701`、hash 前 8 位 `aba19e40…` —— 不匹配 UUID/64hex 正则，且是
//     `business-read.ts`（HEAD `78b12ae`）已确立的 render 口径，本检查放行。
//   * machine arguments 区：`next tools (machine arguments — copy verbatim into tool calls;
//     never show ids or hashes to the human):` 之后、缩进 2 空格的续行。模型必须逐字复制 args
//     才能调下游工具，所以这段允许完整 id；header 必须逐字带上"不要给人看"的告诫（否则视为
//     人读正文，正文一律不许出现完整 id）。为什么选"分区放行"而不是"连机器区也禁"：
//     `recruitment_*` 的参数校验是严格 UUID（`uuid: true`），short ref 无法被下游工具解析；
//     而 DSH 只把 render 文本给模型看，把机器区也清掉会让模型拿不到可解析的 id、下游工具直接
//     不可达（R2）。风险由"机器区只能出现在该 header 之后 + header 逐字含告诫 + 人读正文零泄露"
//     三条约束共同兜住。
//   * `record_version=<整数>`：业务版本号（数字），不是内部编号，且 `business-read.ts` 的
//     既有 render 口径就是它；本检查不把它当内部字段名。
//   * 内部字段名（`payload_hash` / `basis_refs` / `event_id`）在人读正文里也不许出现（单独断言，
//     结构化字段里保留）。
//
// 为什么不是扫源码字符串：模板字符串可以拼接、可以走 helper、可以在 helper 里间接引用字段；
// 扫源码只能证明"某段文本里没有字面量 UUID"，证明不了"render 实际输出里没有值级 UUID"。
// 本文件执行真实 render 函数 —— 唯一能证明模型实际读到什么。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ReadonlyToolDefinition } from '../../src/tools/definition.ts'

// ---------------------------------------------------------------------------
// 值级检测器（本文件是唯一权威；meta 测试证明它真的会红）
// ---------------------------------------------------------------------------

/** 完整 UUID（8-4-4-4-12）。 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
/** 完整 64hex（sha256 等）。 */
const HASH64_RE = /[0-9a-f]{64}/i
/**
 * 32+ 连续 hex：既可能是"完整 sha256 漏了一半"，也可能是**去掉连字符的 UUID**
 * （32 hex 正是 UUID 的 hex 主体）。产品口径是"不许把内部编号念给用户"，所以一并拦。
 * 短号（8 位 hash 前缀、4 位 UUID 尾巴）不会被这条命中。
 */
const LONG_HEX_RE = /[0-9a-f]{32,}/i
/** 人读正文里也不许出现的内部字段名（结构化字段里保留）。 */
const INTERNAL_FIELD_NAME_RE = /\b(payload_hash|basis_refs|event_id)\b/
/** machine arguments 区的 header（必须逐字带告诫；否则不放行）。 */
const MACHINE_HEADER_RE = /machine arguments/i
const MACHINE_HEADER_NOTICE_RE = /never show ids or hashes to the human/i

interface Violation {
  readonly tool: string
  readonly variant: string
  readonly lineNo: number
  readonly line: string
  readonly hit: string
  readonly kind: string
}

/**
 * 找出 render 文本里"人读正文"部分的每一条命中（machine arguments 区除外）。
 *
 * 机器参数区有两种合法形态（都由同一个 header 字面量界定）：
 *   * 多行：header 独占一行，后面跟缩进 2 空格的 `key=value` 续行；
 *   * 单行：header 之后、同一行剩下的部分（`recruitment_transcript_import` 的 render 契约是
 *     "单行摘要"，既有断言 `text.includes('\n') === false` 不许放宽，所以机器参数只能内联）。
 * 无论哪种形态，header **之前**的内容一律按人读正文检查。
 * @param text - 完整 render 文本。
 * @param tool - 工具名（失败信息要用）。
 * @param variant - 合成值变体名。
 * @returns 命中列表（空 = 干净）。
 */
function findViolations(text: string, tool: string, variant: string): Violation[] {
  const lines = text.split('\n')
  const violations: Violation[] = []
  let inMachineBlock = false
  lines.forEach((line, index) => {
    if (inMachineBlock) {
      // machine 区 = header 之后、缩进 2 空格的续行；遇到非缩进行就离开该区。
      if (line.startsWith('  ')) return
      inMachineBlock = false
    }
    const headerIndex = line.search(MACHINE_HEADER_RE)
    if (headerIndex >= 0) {
      // 机器参数区必须自报"不要给用户看"；没有告诫 = 当人读正文处理（下面照常扫描）。
      if (MACHINE_HEADER_NOTICE_RE.test(line)) {
        // 只扫 header 之前的部分（header 之后同一行 = 内联机器参数，放行）。
        const before = line.slice(0, headerIndex)
        for (const [kind, re] of [
          ['完整 UUID', UUID_RE],
          ['完整 64hex', HASH64_RE],
          ['32+ 连续 hex（去连字符 UUID / 半截 sha256）', LONG_HEX_RE],
          ['内部字段名出现在人读正文', INTERNAL_FIELD_NAME_RE],
        ] as const) {
          const match = re.exec(before)
          if (match !== null) {
            violations.push({ tool, variant, lineNo: index + 1, line, hit: match[0], kind })
          }
        }
        inMachineBlock = true
        return
      }
      violations.push({
        tool,
        variant,
        lineNo: index + 1,
        line,
        hit: line.trim(),
        kind: 'machine arguments header 缺少 "never show ids or hashes to the human" 告诫',
      })
      return
    }
    for (const [kind, re] of [
      ['完整 UUID', UUID_RE],
      ['完整 64hex', HASH64_RE],
      ['32+ 连续 hex（去连字符 UUID / 半截 sha256）', LONG_HEX_RE],
    ] as const) {
      const match = re.exec(line)
      if (match !== null) {
        violations.push({ tool, variant, lineNo: index + 1, line, hit: match[0], kind })
      }
    }
    const fieldMatch = INTERNAL_FIELD_NAME_RE.exec(line)
    if (fieldMatch !== null) {
      violations.push({
        tool,
        variant,
        lineNo: index + 1,
        line,
        hit: fieldMatch[0],
        kind: '内部字段名出现在人读正文',
      })
    }
  })
  return violations
}

/** 命中列表 → 可直接读的失败信息。 */
function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((item) => `  [${item.tool} / ${item.variant}] line ${item.lineNo}: ${item.kind} 命中 "${item.hit}"\n`
      + `      行原文: ${item.line}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// 合成值：按工具自己声明的 output.schema 造"到处是完整内部编号"的规范值
// ---------------------------------------------------------------------------

/** 合成用的固定 UUID（每个字段不同，便于失败信息定位；末 4 位各不相同）。 */
function synthUuid(seed: number): string {
  const tail = String(seed).padStart(4, '0').slice(-4)
  const block = String(seed).padStart(12, '0').slice(-12)
  return `11111111-1111-4111-8111-${block.slice(0, 8)}${tail}`
}

/** 合成用的固定 64hex（每条不同）。 */
function synthHash(seed: number): string {
  const body = seed.toString(16).padStart(6, '0')
  return `${body}${'0123456789abcdef'.repeat(4)}`.slice(0, 64)
}

/** 名字像 UUID 的字段。 */
function looksLikeId(name: string): boolean {
  // 外部平台签发的 id（飞书会议号 / 日历事件 id）不是我们的内部编号：真实值是provider 侧的
  // 数字/短串。合成值也按外部形态给，避免把"该不该展示外部会议号"误判成内部编号泄露。
  if (/(^|_)(external_.*|calendar_event_id)$/i.test(name)) return false
  return name === 'id' || /(^|_)id$/i.test(name) || /Id$/.test(name)
}

/** 名字像 hash 的字段。 */
function looksLikeHash(name: string): boolean {
  return /sha256|sha_256|(^|_)hash$|digest$/i.test(name)
}

/** 名字像时间戳的字段。 */
function looksLikeTimestamp(name: string): boolean {
  return /(_at|_time|_date)$/i.test(name) || name === 'as_of' || name === 'asOf'
}

/** 名字像计数的字段。 */
function looksLikeCount(name: string): boolean {
  return /(count|total|no|size|pages|minutes|version|revision|weight|score|chars|length)$/i.test(name)
}

/** 一个用 schema 合成出来的值（`mode` 控制是否铺满可空分支/数组）。 */
type SynthMode = 'full' | 'sparse'

interface SynthContext {
  readonly mode: SynthMode
  seed: number
}

/**
 * 按 JSON Schema 合成规范值。
 * @param schema - 声明式 schema（官方强制子集：type/properties/required/items/enum/oneOf/const）。
 * @param name - 该值在父对象里的键名（用于 id/hash/时间戳判定）。
 * @param ctx - 合成上下文（种子用于保证每个 id 都不同且都是完整 UUID）。
 */
function synthValue(schema: unknown, name: string, ctx: SynthContext): unknown {
  if (typeof schema !== 'object' || schema === null) return 'demo-text'
  const node = schema as Record<string, unknown>
  const nextSeed = (): number => ctx.seed++

  // oneOf/anyOf：取第一个非 null 分支；sparse 优先取 null 分支（覆盖"没数据"的 render 分支）。
  const branches = (node.oneOf ?? node.anyOf) as readonly unknown[] | undefined
  if (Array.isArray(branches) && branches.length > 0) {
    const nullBranch = branches.find((branch) => (branch as Record<string, unknown>)?.type === 'null')
    if (ctx.mode === 'sparse' && nullBranch !== undefined) return null
    const valueBranch = branches.find((branch) => (branch as Record<string, unknown>)?.type !== 'null')
    return synthValue(valueBranch ?? branches[0], name, ctx)
  }
  if ('const' in node) return node.const
  const enumValues = node.enum as readonly unknown[] | undefined
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0]

  const type = typeof node.type === 'string' ? node.type : undefined
  if (type === 'null') return null
  if (type === 'boolean') return true
  if (type === 'integer' || type === 'number') return looksLikeCount(name) ? 3 : 3
  if (type === 'string') {
    if (looksLikeId(name)) return synthUuid(nextSeed())
    if (looksLikeHash(name)) return synthHash(nextSeed())
    if (looksLikeTimestamp(name)) return '2026-11-16T10:00:00+08:00'
    if (name === 'timezone') return 'Asia/Shanghai'
    if (name === 'contract_version') return '1.0.0'
    if (/(^|_)(code)$/i.test(name)) return 'DEMO-BE-001'
    if (/(_html|_md)$/i.test(name)) return '演示段落：负责后端服务。'
    if (/(^|_)(status|state)$/i.test(name)) return 'ACTIVE'
    return `demo-${name}`
  }
  if (type === 'array') {
    if (ctx.mode === 'sparse') return []
    return [synthValue(node.items, name, ctx), synthValue(node.items, name, ctx)]
  }
  const properties = node.properties as Record<string, unknown> | undefined
  if (properties !== undefined) {
    const required = new Set((node.required as readonly string[] | undefined) ?? [])
    const out: Record<string, unknown> = {}
    for (const [key, childSchema] of Object.entries(properties)) {
      if (ctx.mode === 'sparse' && !required.has(key) && !isNullableSchema(childSchema)) continue
      out[key] = synthValue(childSchema, key, ctx)
    }
    return out
  }
  // `additionalProperties: true` 的自由对象（例如 rubric criterion 逐字回显）：
  // 给一组看起来像内部编号的键值，验证 render 不会把 echo 出来的完整 id 直接打印。
  return {
    id: synthUuid(nextSeed()),
    key: 'criterion_demo',
    kind: 'MUST_HAVE',
    weight: 3,
    label: '演示维度',
    field: 'years_of_experience',
    operator: '>=',
    value: 3,
    question: '候选人有几年后端经验？',
    sha256: synthHash(nextSeed()),
  }
}

/** 这个 schema 是否可空（oneOf/anyOf 里含 null 分支）。 */
function isNullableSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false
  const node = schema as Record<string, unknown>
  const branches = (node.oneOf ?? node.anyOf) as readonly unknown[] | undefined
  return Array.isArray(branches)
    && branches.some((branch) => (branch as Record<string, unknown>)?.type === 'null')
}

// ---------------------------------------------------------------------------
// 假依赖：只造工具（工厂保存引用），从不 execute —— 所以永远不连库
// ---------------------------------------------------------------------------

const FAKE_DATABASE = {
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'ra_render_lint_never_connected',
  password: 'render-lint-only',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000,
  max: 2,
} as never

const FAKE_CONVERTER = {
  python_bin: 'python',
  converter_dir: '/converter',
  allowed_roots: ['/allowed'],
  timeout_ms: 180_000,
} as never

const FAKE_DEPS = {
  identity: { resolve: async () => ({ actor_id: '11111111-1111-4111-8111-000000000103' }) },
  approval: { request: async () => ({ approved: true }) },
} as never

const FAKE_ISSUES = ['database.host missing', 'database.password env missing']
const FAKE_CONNECTOR = { read: async () => ({}) } as never

// ---------------------------------------------------------------------------
// 工厂清单：`src/tools/*.ts` 里每一个 create* 都必须在这里被**真的调用**
// ---------------------------------------------------------------------------

interface FactoryEntry {
  /** 模块导出的工厂函数名。 */
  readonly factory: string
  /** 传给工厂的实参（假配置）。 */
  readonly args?: readonly unknown[]
  /** 该工厂返回数组（多工具文件）。 */
  readonly returnsArray?: boolean
}

const TOOL_FACTORIES: Readonly<Record<string, readonly FactoryEntry[]>> = {
  'application-intake.ts': [
    { factory: 'createApplicationIntakeTool', args: [{ converter: FAKE_CONVERTER, database: FAKE_DATABASE }, FAKE_DEPS] },
    { factory: 'unconfiguredApplicationIntakeTool', args: [FAKE_ISSUES] },
  ],
  'business-read.ts': [
    { factory: 'createBusinessReadTools', args: [{ database: FAKE_DATABASE, converter: FAKE_CONVERTER }], returnsArray: true },
    { factory: 'unconfiguredBusinessReadTools', args: [FAKE_ISSUES, FAKE_ISSUES], returnsArray: true },
  ],
  'candidate-get.ts': [
    { factory: 'createCandidateGetTool', args: [FAKE_DATABASE] },
    { factory: 'unconfiguredCandidateGetTool', args: [FAKE_ISSUES] },
  ],
  'config-pipeline.ts': [
    { factory: 'createConfigPipelineTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'unconfiguredConfigPipelineTool', args: [FAKE_ISSUES] },
  ],
  'config-role.ts': [
    { factory: 'createConfigRoleTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'unconfiguredConfigRoleTool', args: [FAKE_ISSUES] },
  ],
  'config-team.ts': [
    { factory: 'createConfigTeamTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'unconfiguredConfigTeamTool', args: [FAKE_ISSUES] },
  ],
  'decision-record.ts': [
    { factory: 'createDecisionRecordTool', args: [{ database: FAKE_DATABASE, ...(FAKE_DEPS as object) }] },
  ],
  'document-read.ts': [
    { factory: 'createDocumentReadTool', args: [FAKE_CONVERTER, {}] },
    { factory: 'unconfiguredDocumentReadTool', args: [FAKE_ISSUES] },
  ],
  'evaluation-summarize.ts': [
    { factory: 'createEvaluationSummarizeTool', args: [{ database: FAKE_DATABASE }] },
  ],
  'interview-get.ts': [
    { factory: 'createInterviewGetTool', args: [FAKE_DATABASE] },
    { factory: 'unconfiguredInterviewGetTool', args: [FAKE_ISSUES] },
  ],
  'interview-record-verify.ts': [
    { factory: 'createInterviewRecordVerifyTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'unconfiguredInterviewRecordVerifyTool', args: [FAKE_ISSUES] },
  ],
  'interview-schedule.ts': [
    { factory: 'createInterviewScheduleTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'unconfiguredInterviewScheduleTool', args: [FAKE_ISSUES] },
  ],
  'job-create.ts': [
    { factory: 'createJobCreateTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'createJobUpdateTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'unconfiguredJobCreateTool', args: [FAKE_ISSUES] },
    { factory: 'unconfiguredJobUpdateTool', args: [FAKE_ISSUES] },
  ],
  'job-draft.ts': [
    { factory: 'createJobDraftTool' },
  ],
  'job-get.ts': [
    { factory: 'createJobGetTool', args: [FAKE_DATABASE] },
    { factory: 'unconfiguredJobGetTool', args: [FAKE_ISSUES] },
  ],
  'job-rubric-approve.ts': [
    { factory: 'createJobRubricApproveTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'unconfiguredJobRubricApproveTool', args: [FAKE_ISSUES] },
  ],
  'page-image.ts': [
    { factory: 'createPageImageTool', args: [FAKE_CONVERTER] },
    { factory: 'unconfiguredPageImageTool', args: [FAKE_ISSUES] },
  ],
  'record-human-decision.ts': [
    { factory: 'createRecordHumanDecisionTool', args: [{ database: FAKE_DATABASE, ...(FAKE_DEPS as object) }] },
  ],
  'resume-read.ts': [
    { factory: 'createResumeReadTool', args: [FAKE_CONVERTER] },
  ],
  'scorecard-submit.ts': [
    { factory: 'createScorecardSubmitTool', args: [{ database: FAKE_DATABASE, ...(FAKE_DEPS as object) }] },
  ],
  'screening-evaluate.ts': [
    { factory: 'createScreeningEvaluateTool', args: [FAKE_DATABASE] },
    { factory: 'unconfiguredScreeningEvaluateTool', args: [FAKE_ISSUES] },
  ],
  'stage-advance.ts': [
    { factory: 'createStageAdvanceTool', args: [FAKE_DATABASE, FAKE_DEPS] },
    { factory: 'unconfiguredStageAdvanceTool', args: [FAKE_ISSUES] },
  ],
  'structure-tools.ts': [
    { factory: 'createResumeSerializeTool', args: [FAKE_CONVERTER] },
    { factory: 'createStructureValidateTool', args: [FAKE_CONVERTER] },
  ],
  'trace-get.ts': [
    { factory: 'createTraceGetTool', args: [FAKE_DATABASE] },
    { factory: 'unconfiguredTraceGetTool', args: [FAKE_ISSUES] },
  ],
  'transcript-import.ts': [
    {
      factory: 'createTranscriptImportTool',
      args: [FAKE_DATABASE, { ...(FAKE_DEPS as object), connector: FAKE_CONNECTOR, connector_issues: [] }],
    },
    { factory: 'unconfiguredTranscriptImportTool', args: [FAKE_ISSUES] },
  ],
  'transcript-read.ts': [
    { factory: 'createTranscriptReadTool', args: [FAKE_DATABASE] },
    { factory: 'unconfiguredTranscriptReadTool', args: [FAKE_ISSUES] },
  ],
  'vision-fallback.ts': [
    { factory: 'createModelTextMergeTool', args: [FAKE_CONVERTER] },
    { factory: 'unconfiguredModelTextMergeTool', args: [FAKE_ISSUES] },
  ],
}

/** `src/tools/` 下**不是**工具模块的文件（有理由的排除项）。 */
const NON_TOOL_MODULES: Readonly<Record<string, string>> = {
  'args.ts': '参数解析/校验 helper，无工具定义',
  'contract.ts': '错误与 JSON 规范化 helper，无工具定义',
  'converter.ts': 'converter 配置解析 helper，无工具定义',
  'definition.ts': '工具定义形状（interface），无工具定义',
  'errors.ts': '错误类型，无工具定义',
  'fallback-bridge.ts': '模型兜底桥 helper，无工具定义',
  'config-shared.ts': '配置读视图的公共 render helper（由 config-* 工具调用），无工具定义',
  'render-ref.ts': 'render 短号 / 机器参数区 helper（本机检的白名单口径），无工具定义',
  'scorecard-progress.ts': '必交面评进度的纯函数派生实现（被 interview-get / application-get 复用），无工具定义',
  // trace 留痕接线（D-141 §4）：这是**工具定义的包装器**（`withToolCallTrace(tool, deps)` 浅拷贝
  // 原工具、只替换 `execute`），文件里没有任何 `create*Tool` / `unconfigured*Tool` 工厂、没有自己的
  // `output.render`，所以没有"模型可见文本"可执行；它返回的仍是别的文件里已登记的工具定义，
  // 那些工具已由本机检逐条执行。排除它是**有理由的具体项**，不是"忽略所有未知文件"——
  // 真正新增一个工具文件（含 create* 工厂）仍然会在这里报红。
  'traced.ts': '工具定义包装器（withToolCallTrace：浅拷贝 + 只替换 execute），无工具定义/无 render',
}

/**
 * 导出名以 `create*` 开头但**不是**工具工厂（不进机检执行清单，逐条给理由）。
 */
const NOT_A_TOOL_FACTORY: Readonly<Record<string, string>> = {
  'job-create.ts:createJobInTransaction': '事务内的写 helper（首个参数是 DB client），不是工具定义',
}

/**
 * 由别的工厂**组装**出来的工具工厂（返回同一个工具定义；已在组装工厂里被执行过）。
 */
const SUB_FACTORIES: Readonly<Record<string, string>> = {
  'business-read.ts:createApplicationGetTool': '由 createBusinessReadTools 组装（本文件已执行该数组工厂）',
  'business-read.ts:createMaterialReadTool': '由 createBusinessReadTools 组装（本文件已执行该数组工厂）',
}

/** `src/tools/` 目录绝对路径。 */
const TOOLS_DIR = fileURLToPath(new URL('../../src/tools/', import.meta.url))

/** 本目录下全部 `.ts` 文件名（按名排序）。 */
function listToolFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .sort()
}

interface ExecutedTool {
  readonly file: string
  readonly name: string
  readonly tool: ReadonlyToolDefinition
}

let cache: readonly ExecutedTool[] | null = null

/** 造出全部工具（每个工具工厂只调用一次）。 */
async function buildAllTools(): Promise<readonly ExecutedTool[]> {
  if (cache !== null) return cache
  const executed: ExecutedTool[] = []
  for (const file of listToolFiles()) {
    const entries = TOOL_FACTORIES[file]
    if (entries === undefined) continue
    const mod = (await import(new URL(`../../src/tools/${file}`, import.meta.url).href)) as Record<string, unknown>
    for (const entry of entries) {
      const factory = mod[entry.factory]
      assert.equal(typeof factory, 'function', `${file} 没有导出工厂 ${entry.factory}（镜像已过期？）`)
      const created = (factory as (...factoryArgs: readonly unknown[]) => unknown)(...(entry.args ?? []))
      const tools = (entry.returnsArray === true ? created : [created]) as readonly ReadonlyToolDefinition[]
      for (const tool of tools) executed.push({ file, name: tool.name, tool })
    }
  }
  cache = executed
  return cache
}

// ---------------------------------------------------------------------------
// 测试 1：检测器自身有效（meta —— 证明"它真的会红"）
// ---------------------------------------------------------------------------

test('meta：检测器必须抓到人读正文里的完整 UUID / 64hex（证明本检查不是摆设）', () => {
  const poisoned = [
    'job DEMO-BE-001 后端工程师 [OPEN]  (labels: FIXTURE/MANUAL/CONNECTED)',
    '  job_id=11111111-1111-4111-8111-000000000401  record_version=3',
    `  job_version v1  hash=${'a'.repeat(64)}…`,
    '  asset sha256=' + 'b'.repeat(64),
  ].join('\n')
  const violations = findViolations(poisoned, 'meta-tool', 'full')
  assert.ok(violations.some((item) => item.kind === '完整 UUID'), '完整 UUID 未被抓到')
  assert.ok(violations.some((item) => item.kind === '完整 64hex'), '完整 64hex 未被抓到')
  assert.ok(violations.some((item) => item.lineNo === 2), '行号定位不对')
  assert.match(formatViolations(violations), /meta-tool \/ full\] line 2/)
})

test('meta：短号 / 短 hash 必须放行（不误报）', () => {
  const clean = [
    '申请：演示候选人-张样例 · DEMO-BE-001 后端工程师（演示） · 阶段 S7',
    '  material: resume_version=…0701 parse_status=PARSED pages=1',
    '  asset: …0613 demo-candidate-0701.rtf 516B sha256=3c12527f… (VALID)',
    '  job_version v1 hash=aba19e40…',
    'interview 第 2 轮 round=2 slot=DEFAULT stage=S8 [SCHEDULED]',
  ].join('\n')
  assert.deepEqual(findViolations(clean, 'meta-tool', 'full'), [])
})

test('meta：machine arguments 区允许完整 id，但 header 必须逐字带"不要给人看"的告诫', () => {
  const withMachine = [
    'application 申请：演示候选人-张样例 · DEMO-BE-001',
    'next tools (machine arguments — copy verbatim into tool calls; never show ids or hashes to the human):',
    '  recruitment_material_read {"application_id":"11111111-1111-4111-8111-000000000701"} — read material',
  ].join('\n')
  assert.deepEqual(findViolations(withMachine, 'meta-tool', 'full'), [])

  const bareHeader = [
    'application 申请：演示候选人-张样例 · DEMO-BE-001',
    'machine arguments (copy verbatim into tool calls):',
    '  recruitment_material_read {"application_id":"11111111-1111-4111-8111-000000000701"} — read material',
  ].join('\n')
  const violations = findViolations(bareHeader, 'meta-tool', 'full')
  assert.ok(
    violations.some((item) => item.kind.includes('machine arguments header')),
    'header 缺告诫时必须报错',
  )
  // header 缺告诫 ⇒ 后续 id 行按人读正文算，必须也被抓到。
  assert.ok(violations.some((item) => item.kind === '完整 UUID'))
})

// ---------------------------------------------------------------------------
// 测试 2：覆盖守卫 —— 每个工具文件 / 工厂都必须被本检查执行
// ---------------------------------------------------------------------------

test('覆盖：src/tools/*.ts 里每个工具工厂都被本检查真的调用过（新增工具漏检即红）', async () => {
  await buildAllTools()
  const missing: string[] = []
  for (const file of listToolFiles()) {
    if (NON_TOOL_MODULES[file] !== undefined) continue
    const entries = TOOL_FACTORIES[file]
    if (entries === undefined) {
      missing.push(`${file}: 未登记在 TOOL_FACTORIES（新增工具必须让机检执行它的 render）`)
      continue
    }
    const mod = (await import(new URL(`../../src/tools/${file}`, import.meta.url).href)) as Record<string, unknown>
    const factoryNames = Object.entries(mod)
      .filter(([key, value]) => (key.startsWith('create') || key.startsWith('unconfigured')) && typeof value === 'function')
      .map(([key]) => key)
    const covered = new Set(entries.map((entry) => entry.factory))
    for (const name of factoryNames) {
      if (covered.has(name)) continue
      if (`${file}:${name}` in SUB_FACTORIES || `${file}:${name}` in NOT_A_TOOL_FACTORY) continue
      missing.push(`${file}: 工厂 ${name} 未被执行（新增工厂必须进 TOOL_FACTORIES）`)
    }
  }
  // NON_TOOL_MODULES 里若混进了工具工厂，也是错的。
  for (const [file, reason] of Object.entries(NON_TOOL_MODULES)) {
    if (!listToolFiles().includes(file)) {
      missing.push(`${file}: 已列入排除项（${reason}）但文件不存在，请清理排除项`)
      continue
    }
    const mod = (await import(new URL(`../../src/tools/${file}`, import.meta.url).href)) as Record<string, unknown>
    const factories = Object.keys(mod).filter((key) => key.startsWith('create') || key.startsWith('unconfigured'))
    if (factories.length > 0) missing.push(`${file}: 排除项（${reason}）里出现了工具工厂 ${factories.join(',')}`)
  }
  assert.deepEqual(missing, [], `机检覆盖缺口：\n${missing.join('\n')}`)
})

// ---------------------------------------------------------------------------
// 测试 3：核心断言 —— 所有工具 render 的人读正文里没有内部编号
// ---------------------------------------------------------------------------

test('render 人读正文不出现完整 UUID / 完整 64hex / 32+ 连续 hex（所有 src/tools 工具）', async () => {
  const tools = await buildAllTools()
  assert.ok(tools.length >= 40, `只执行到 ${tools.length} 个工具，覆盖异常`)

  const violations: Violation[] = []
  const notExecuted: { readonly tool: string; readonly error: string }[] = []
  const sparseSkipped: { readonly tool: string; readonly error: string }[] = []
  let executed = 0

  for (const { name, tool } of tools) {
    const schema = tool.output.schema
    let success = false
    for (const variant of ['full', 'sparse'] as const) {
      const value = synthValue(schema, '', { mode: variant, seed: 1 })
      let text: string
      try {
        text = tool.output.render({}, value).map((block) => block.text).join('\n')
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        if (variant === 'full') {
          notExecuted.push({ tool: name, error: message })
        } else {
          sparseSkipped.push({ tool: name, error: message })
        }
        continue
      }
      success = true
      violations.push(...findViolations(text, name, variant))
    }
    if (success) executed += 1
  }

  const problems: string[] = []
  if (notExecuted.length > 0) {
    problems.push('render 无法用合成规范值执行（必须为它补合成值或明确豁免理由）：\n'
      + notExecuted.map((item) => `  - ${item.tool}: ${item.error}`).join('\n'))
  }
  if (violations.length > 0) {
    problems.push(`render 人读正文泄露内部编号 ${violations.length} 处：\n${formatViolations(violations)}`)
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`)
  assert.ok(executed >= 40, `只成功执行 ${executed} 个工具的 render`)
  // sparse 变体在"render 假定非空"时允许跳过；这里只落日志，不放过 full 变体的失败。
  assert.ok(sparseSkipped.length <= 40, `sparse 变体失败过多（${sparseSkipped.length}），合成值需要维护`)
})

// ---------------------------------------------------------------------------
// 测试 4：内部字段名不许出现在人读正文（结构化字段里保留）
// ---------------------------------------------------------------------------

test('render 人读正文不出现 payload_hash / basis_refs / event_id 这类内部字段名', async () => {
  const tools = await buildAllTools()
  const violations: Violation[] = []
  for (const { name, tool } of tools) {
    for (const variant of ['full', 'sparse'] as const) {
      const value = synthValue(tool.output.schema, '', { mode: variant, seed: 1 })
      let text: string
      try {
        text = tool.output.render({}, value).map((block) => block.text).join('\n')
      } catch {
        continue
      }
      violations.push(...findViolations(text, name, variant).filter((item) => item.kind === '内部字段名出现在人读正文'))
    }
  }
  assert.deepEqual(violations, [], `内部字段名泄露：\n${formatViolations(violations)}`)
  // 检测器自身有效（meta）。
  assert.ok(
    findViolations('decision basis_refs=[1] event_id=11111111-1111-4111-8111-000000000901', 'meta', 'full')
      .some((item) => item.kind === '内部字段名出现在人读正文'),
  )
})

// 让本文件在"没有工具被枚举"时也明确失败（防止目录扫错导致空跑变绿）。
test('前置：确实读到了 src/tools 目录', () => {
  const files = listToolFiles()
  assert.ok(files.includes('job-get.ts'))
  assert.ok(files.includes('business-read.ts'))
  const source = readFileSync(fileURLToPath(new URL('../../src/tools/job-get.ts', import.meta.url)), 'utf8')
  assert.match(source, /render\(/)
})
