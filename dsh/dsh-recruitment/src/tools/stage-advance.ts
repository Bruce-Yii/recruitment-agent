// recruitment_application_stage_advance —— 阶段推进的**唯一写入口**（复审 N8 / 方案 D）。
//
// 形状权威：`contracts/stage-advance/tool-contracts.md`（下称 TC）。
// 领域实现：`src/domain/stage-advance.ts`（判定 + 版本守卫 + stage_entered_at，全部在那儿）。
// 本文件只做三件"胶水"：
//   1. 入参收窄到**一个必填键** `{application_id}`（+ 两个可选键：人工原话 `override`、
//      乐观并发 `expected_record_version`）。目标阶段、actor、tenant 一概不收 ——
//      本命令不新增授权，只承认已发生的事实（收 `to_stage` 就等于给模型一个"跳阶开关"）。
//   2. 事务与身份：`withActor`（`BEGIN` + `SET LOCAL recruitment.actor_id`）——
//      `fn_row_guard` 只认这条路径给出的 actor；缺了它会 ACTOR_REQUIRED 拒绝。
//   3. 出参：领域结果 + R4 三维标签。**labels 只回答"数据真假/谁触发/有没有外部系统"**，
//      不回答"谁做的决定"（见下）。
//
// ⚠️ actor 诚实（契约里也明文写死，不许省）：
//   `application.stage_changed_by_actor_id` 由 `fn_row_guard` 写成 `SET LOCAL recruitment.actor_id`
//   ——它表示**执行账号**，**不表示决策人**。T1（S6→S7）是**自动推进**：库里的 actor 是配置里的
//   本地账号（`…0103`，HUMAN 类型），但没有任何人"按过这个按钮"。T3（S8→S9）/ T4（S9→S10）
//   同样是**承认已发生的事实**（面试已发生 / 材料已可取），不是"人点了推进"。所以：
//     * 本工具不写 `decided_by_actor_id`、不写决策、不建任务（那是 decision_record 的事）；
//     * 输出/契约里都不把 stage 变化表述成"某人推进了它"；
//     * 想证明"是谁决定的"，唯一凭据是 `decision` 行（`decided_by_actor_id` + 人工确认哈希）。
//
// 不做什么（TC §0 六条）：不代决、不改 lifecycle_status、不写 stage_blocked_reason、
// 不改任何决策。F1 的 rubric 补钉（申请没钉、岗位已有已批准 current）在**领域层**的 T1 判定里
// 作为"承认已批准事实"的补写发生（`contracts/stage-advance/tool-contracts.md §2.1.1`）。
//
// 配置不完整时**仍然注册同一个工具名**，调用返回 NOT_CONFIGURED 并列出缺什么 ——
// 模型看到的是"为什么不能用"，而不是一个不存在的工具（沿用 candidate_get 的既有做法）。

import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { machineArgumentLines, shortRef } from './render-ref.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  closePool,
  createPool,
  withActor,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { buildThreeAxisLabels, type ThreeAxisLabels } from './candidate-get.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'
import {
  advanceApplicationStage,
  advanceApplicationStageWithOverride,
  BLOCKER_CODES,
  NEXT_ACTION_CODES,
  OWNER_ROLES,
  WARNING_CODES,
  type StageAdvanceStatus,
  type StageBlocker,
  type StageOverride,
  type StageTransition,
  type StageWarning,
} from '../domain/stage-advance.ts'

/** 工具名（`test/` 与总控注册时都按这个名字找）。 */
const TOOL_NAME = 'recruitment_application_stage_advance'

/**
 * 出参契约版本（TC §4 的形状变了就要 +1）。
 * v1.1.0（§11.6-8 复审）：blockers/warnings 每一项升级为**结构化责任 + 下一步**。
 * v1.2.0（D-A 修复）：梯子从两条边扩到四条（S8→S9 / S9→S10），新增 blocker 码
 * （`INTERVIEW_NOT_COMPLETED` / `TRANSCRIPT_NOT_READY`）与 next_action_code
 * （`SCHEDULE_INTERVIEW` / `IMPORT_TRANSCRIPT` / `RESCHEDULE_INTERVIEW` / `REIMPORT_TRANSCRIPT`）。
 * v1.3.0（G3 裁决 B）：T3 = 材料就绪（canonical READY 转写），`interview.status` 只作排期状态；
 * T4 增加「该申请关联面试 ≥1 份 SUBMITTED 面评」前置 → 新 blocker 码 `SCORECARD_REQUIRED`
 * 与新 next_action_code `SUBMIT_SCORECARD`（0 份时零写入）。
 */
const CONTRACT_VERSION = '1.3.0'

// =====================================================================
//  入参（**只有一个键**）
// =====================================================================

const PARAMS: ParamMap = {
  application_id: {
    kind: 'string',
    required: true,
    uuid: true,
    description:
      '申请 id（UUID）。目标阶段由"已发生的事实"推导'
      + '（T1 S6→S7 / T2 S7→S8 / T3 S8→S9 / T4 S9→S10，S10 是 v1.0 终态），'
      + 'actor 与 tenant 只能来自执行上下文。',
  },
  // 乐观并发（可选）：调用方认为的 application.record_version（先 application_get 拿 record_version）。
  // 放进 PARAMS ⇒ 自动进 schema（D-157：新参数必须模型可见）；parseArgs 负责整数/>=1 校验。
  // 传了 → 版本不符由领域写路径在同事务 `select … for update` 持锁读后比较并拒绝
  //        （VERSION_CONFLICT / STALE_RECORD_VERSION，零写入、零审计事件、零版本 +1）；
  // 不传 → undefined，领域层完全沿用原写路径（不加任何新 WHERE / 事件 / 出参改动）。
  expected_record_version: {
    kind: 'integer',
    required: false,
    min: 1,
    description:
      'Optional optimistic-concurrency guard: the application.record_version the caller last read '
      + '(integer >= 1; get it first via recruitment_application_get). When supplied and it differs from '
      + 'the stored record_version, the call fails atomically with VERSION_CONFLICT / '
      + 'STALE_RECORD_VERSION (detail: expected_record_version, actual_record_version) with zero writes '
      + 'and zero audit events. When omitted, behaviour is byte-for-byte unchanged.',
  },
  // AT-6/7 的 override 是**可选**参数，域类型是对象 {reason, confirmation_text}，
  // 而本插件的 ParamMap 只支持标量（string/integer/boolean/string[]）。arg 校验在
  // parseOverrideArg() 里做（含 unknown key 拒绝 + 两侧长度），`additionalProperties:false`
  // 由 toParameterSchema 生成，模型可见性由 DESCRIPTION 明文给出（保持旧 schema 用例的形状）。
}

// =====================================================================
//  AT-6/7 入参 override：严格校验，**先于任何 DB 连接**（失败即零写入）
// =====================================================================

/** 一个 override 只允许这两个键；`confirmation_text_sha256` 等哈希键是 unknown key，一律拒绝。 */
const OVERRIDE_KEYS: ReadonlySet<string> = new Set(['reason', 'confirmation_text'])

/**
 * 校验/裁剪模型给的 `override`。
 *
 *   * 缺省（没有这个键）→ `undefined`，走原路径（一扇闸门都不放宽）；
 *   * 必须是普通对象、只含 `reason` / `confirmation_text` 两键（unknown key 全部拒绝，
 *     包括模型自报的 `confirmation_text_sha256` —— 哈希只能由服务端算）；
 *   * 两键都必填、都是字符串；trim 后 reason 1..500、confirmation_text 1..2000。
 *
 * 返回的是 **trim 后的字符串**：人话的首尾空白不是"原话"的一部分，服务端哈希的就是这份
 * 裁剪后的原话（与审计 payload 里留存的文本一一对应）。
 * @param raw - 模型给的 override 值。
 * @returns 校验通过的 override；没有 override 键时 `undefined`。
 * @throws RecruitmentToolError - `INVALID_ARGS`（任一条不满足）。
 */
function parseOverrideArg(raw: unknown): StageOverride | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RecruitmentToolError('INVALID_ARGS', 'override must be an object {reason, confirmation_text}')
  }
  const obj = raw as Record<string, unknown>
  const unknown = Object.keys(obj).filter((key) => !OVERRIDE_KEYS.has(key)).sort()
  if (unknown.length > 0) {
    throw new RecruitmentToolError('INVALID_ARGS', `override unknown key(s): ${unknown.join(', ')}`)
  }
  const reason = obj.reason
  const confirmationText = obj.confirmation_text
  if (typeof reason !== 'string') {
    throw new RecruitmentToolError('INVALID_ARGS', 'override.reason must be a string (1..500 chars after trim)')
  }
  if (typeof confirmationText !== 'string') {
    throw new RecruitmentToolError('INVALID_ARGS', 'override.confirmation_text must be a string (1..2000 chars after trim)')
  }
  const trimmedReason = reason.trim()
  const trimmedConfirmation = confirmationText.trim()
  if (trimmedReason.length < 1 || trimmedReason.length > 500) {
    throw new RecruitmentToolError('INVALID_ARGS', 'override.reason must be 1..500 chars after trim')
  }
  if (trimmedConfirmation.length < 1 || trimmedConfirmation.length > 2000) {
    throw new RecruitmentToolError('INVALID_ARGS', 'override.confirmation_text must be 1..2000 chars after trim')
  }
  return { reason: trimmedReason, confirmation_text: trimmedConfirmation }
}

/**
 * 从原始入参里摘出 `override`，其余键原样交给 `parseArgs(PARAMS, ...)`。
 *
 * 这样既让域层拿到 override，又让 `parseArgs` 继续守 application_id 的 UUID/必填校验
 * 与"未知参数一律拒绝"（模型仍能借 override 传 `actor_id` 之类的东西会被 parseArgs 拒）。
 * @param rawArgs - 模型给的原始入参。
 * @returns `{ rest, override }`。
 */
function splitOverrideArg(rawArgs: unknown): { rest: unknown; override: StageOverride | undefined } {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    return { rest: rawArgs, override: undefined }
  }
  const input = rawArgs as Record<string, unknown>
  if (!Object.hasOwn(input, 'override')) return { rest: rawArgs, override: undefined }
  const override = parseOverrideArg(input.override)
  const rest: Record<string, unknown> = { ...input }
  delete rest.override
  return { rest, override }
}

/**
 * `override` 的模型可见 schema（AT-6/7）。
 *
 * 长度上限写在 `description` 里而**不是** `maxLength`：本插件注册的原始 JSON Schema 受
 * DSH 官方子集约束（type/oneOf/properties/required/additionalProperties/items/enum/const
 * + description/title/default/examples），`maxLength` 不在子集里，写进去会让整张工具定义被
 * `assertSupportedJsonSchema` 拒绝。执行期的 1..500 / 1..2000 硬校验在 `parseOverrideArg`。
 */
const OVERRIDE_PARAMETER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'AT-6/7：人工原话授权的跳轮/豁免面评。仅当真人明确授权时才传；'
    + 'reason 1..500 字符（max length 500），confirmation_text 1..2000 字符（max length 2000），'
    + '按 trim 后计长。未知键（含模型自报哈希）一律拒绝。',
  properties: {
    reason: {
      type: 'string',
      description: '为什么要跳轮/豁免（1..500 字符，max length 500，trim 后计长）。',
    },
    confirmation_text: {
      type: 'string',
      description: '人工确认原话逐字文本（1..2000 字符，max length 2000，trim 后计长）。'
        + '服务端自行计算 SHA-256，不接受任何哈希字段。',
    },
  },
  required: ['reason', 'confirmation_text'],
  additionalProperties: false,
}

/** 生成入参 schema：`override` 只进 properties，**绝不**进顶层 required（可选参数）。 */
function stageAdvanceParameters(): Record<string, unknown> {
  const schema = toParameterSchema(PARAMS) as Record<string, unknown>
  const properties = schema.properties as Record<string, unknown>
  properties.override = OVERRIDE_PARAMETER_SCHEMA
  return schema
}

// =====================================================================
//  出参 schema（DSH 子集：type/properties/required/additionalProperties/items/enum；
//  没有 type 数组、没有 type:'null' —— 缺省一律"省略键"）
// =====================================================================

const TRANSITION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    from: { type: 'string', description: '迁移前阶段码（S1–S12）' },
    to: { type: 'string', description: '迁移后阶段码（S1–S12）' },
  },
  required: ['from', 'to'],
  additionalProperties: false,
}

const BLOCKER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...BLOCKER_CODES] },
    message: { type: 'string', description: '为什么挡住（缺什么；不含 PII）' },
    owner_role: {
      type: 'string',
      enum: [...OWNER_ROLES],
      description: '该找谁（封闭集）：JOB_HIRING_MANAGER / RECRUITMENT_OWNER / SCREENING_DECIDER / PLATFORM_OPERATOR',
    },
    next_action_code: {
      type: 'string',
      enum: [...NEXT_ACTION_CODES],
      description: '下一步做什么（封闭集，机检口径；人读说明见契约与 NEXT_ACTION_MESSAGES）',
    },
    owner_actor_id: { type: 'string', description: '具体责任人 UUID：能从库里推出来才有（推不出来省略此键）' },
    owner_display_name: { type: 'string', description: '责任人显示名（来自 recruitment.actor.display_name）' },
  },
  required: ['code', 'message', 'owner_role', 'next_action_code'],
  additionalProperties: false,
}

const WARNING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...WARNING_CODES] },
    message: { type: 'string' },
    owner_role: { type: 'string', enum: [...OWNER_ROLES] },
    next_action_code: { type: 'string', enum: [...NEXT_ACTION_CODES] },
    owner_actor_id: { type: 'string', description: '具体责任人 UUID：能从库里推出来才有' },
    owner_display_name: { type: 'string' },
  },
  required: ['code', 'message', 'owner_role', 'next_action_code'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    application_id: { type: 'string' },
    stage_code: { type: 'string', description: '调用结束后的当前阶段码（NO_OP/BLOCKED 时与调用前相同）' },
    record_version: { type: 'integer', description: '调用结束后的 record_version（没发 UPDATE 就与调用前相同）' },
    status: { type: 'string', enum: ['ADVANCED', 'NO_OP', 'BLOCKED'] },
    transitions: { type: 'array', items: TRANSITION_SCHEMA },
    blockers: { type: 'array', items: BLOCKER_SCHEMA },
    warnings: { type: 'array', items: WARNING_SCHEMA },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
  },
  required: [
    'tool', 'contract_version', 'application_id', 'stage_code', 'record_version',
    'status', 'transitions', 'blockers', 'warnings', 'labels',
  ],
  additionalProperties: false,
}

/** 本工具的规范输出值（`output.schema` 的 TS 影子）。 */
export interface StageAdvanceValue {
  readonly tool: string
  readonly contract_version: string
  readonly application_id: string
  readonly stage_code: string
  readonly record_version: number
  readonly status: StageAdvanceStatus
  readonly transitions: readonly StageTransition[]
  readonly blockers: readonly StageBlocker[]
  readonly warnings: readonly StageWarning[]
  readonly labels: ThreeAxisLabels
}

// =====================================================================
//  工具定义
// =====================================================================

/** 模型可见说明（**每一条边界都必须在这里出现**，否则模型会自己发明语义）。 */
const DESCRIPTION = [
  'Advance ONE application\'s stage pointer by acknowledging facts that have ALREADY happened',
  '(a derived command: it adds no new authority). Required input: {application_id};',
  'two optional keys: {expected_record_version} (optimistic concurrency) and {override} (human words).',
  'No target stage, no actor, no tenant.',
  'Ladder (four edges, in order, never skipped; the chain ends at S10):',
  '  T1 S6->S7: application.resume_version_id is set AND that material\'s parse_status is not FAILED',
  '            AND application.rubric_version_id is set (rubric version pinned);',
  '  T2 S7->S8: the current (superseded_by_decision_id is null) decision with',
  '            decision_scope=SCREENING has result=ADVANCE;',
  '  T3 S8->S9: the material is READY — a canonical + READY transcript artifact exists for this',
  '            application (complete source text acquired). interview.status is ONLY a scheduling',
  '            state (watched for hints / reschedule advice): it NEVER proves the interview happened',
  '            and is NOT a pass condition (G3 decision B);',
  '  T4 S9->S10: the material is usable (canonical + READY transcript) AND this application has',
  '            AT LEAST ONE SUBMITTED scorecard (scorecard.status = SUBMITTED on one of its',
  '            interviews); zero submitted scorecards -> BLOCKED(SCORECARD_REQUIRED) with ZERO',
  '            writes. S10 is TERMINAL: stage_catalog.in_v1_scope ends at S10, so the pointer stops',
  '            at S10 (no invented S11 edge); the S10 decision lives in the decision rows, not in',
  '            the stage pointer.',
  'Returns status=ADVANCED (transitions[] lists the applied edges; one stage-change event per edge),',
  'status=NO_OP (nothing to do: the pointer already reflects the facts, or the next fact is still',
  'pending — ZERO update), or',
  'status=BLOCKED (blockers[] names the blocking fact: RUBRIC_NOT_PINNED, MATERIAL_NOT_LINKED,',
  'status=BLOCKED (blockers[] names the blocking fact: RUBRIC_NOT_PINNED, MATERIAL_NOT_LINKED,',
  'MATERIAL_PARSE_FAILED, SCREENING_DECISION_NOT_ADVANCE, INTERVIEW_NOT_COMPLETED, TRANSCRIPT_NOT_READY,',
  'SCORECARD_REQUIRED, APPLICATION_NOT_ACTIVE, STAGE_NOT_ON_LADDER).',
  'APPLICATION_NOT_ACTIVE, STAGE_NOT_ON_LADDER).',
  'Every blocker/warning is STRUCTURED for the workbench: it always carries owner_role',
  '(JOB_HIRING_MANAGER / RECRUITMENT_OWNER / SCREENING_DECIDER / PLATFORM_OPERATOR) and next_action_code',
  '(PIN_RUBRIC_VERSION / LINK_INTAKE_MATERIAL / REPARSE_MATERIAL / RECORD_SCREENING_DECISION /',
  'SUPERSEDE_SCREENING_DECISION / SCHEDULE_INTERVIEW / IMPORT_TRANSCRIPT / RESCHEDULE_INTERVIEW /',
  'REIMPORT_TRANSCRIPT / SUBMIT_SCORECARD / REOPEN_APPLICATION / START_AT_INTAKE / VERIFY_STAGE_PROGRESSION /',
  'ADVANCE_STAGE / CONTINUE_DOWNSTREAM), plus owner_actor_id / owner_display_name when the responsible',
  'ADVANCE_STAGE / CONTINUE_DOWNSTREAM), plus owner_actor_id / owner_display_name when the responsible',
  'person is derivable from the database (job department hiring manager, or the human who made the',
  'SCREENING decision). Never regresses and never skips: if the pointer is already past S10 it returns a',
  'STAGE_AHEAD warning in warnings[] (same structured shape) and sends no UPDATE.',
  'Every applied edge also writes stage_entered_at.',
  'It does NOT record decisions, does NOT create tasks, and does NOT change lifecycle_status.',
  'HONESTY: application.stage_changed_by_actor_id means the EXECUTING ACCOUNT (who ran the tool),',
  'NOT the decision maker. T1 is an automatic advance (so are T3/T4) — a stage change is not evidence',
  'a human did it.',
  'Errors: NOT_FOUND (unknown application), VERSION_CONFLICT (concurrent change; re-read and retry),',
  'NOT_CONFIGURED, INVALID_ARGS.',
  'OPTIONAL expected_record_version (integer >= 1): the application.record_version you last read',
  '(get it from recruitment_application_get first). When supplied and it differs from the stored version,',
  'the call fails atomically with VERSION_CONFLICT / STALE_RECORD_VERSION (detail:',
  'expected_record_version, actual_record_version) and makes ZERO writes and ZERO audit events.',
  'When omitted, behaviour is unchanged (no extra WHERE, no extra event, no output-shape change).',
  'OPTIONAL override (AT-6/7): {reason: string 1..500 chars, confirmation_text: string 1..2000 chars} —',
  'the human\'s verbatim confirmation words. Only pass it when a HUMAN has explicitly authorized',
  'skipping a gate / waiving an unsubmitted scorecard, and give the human\'s reason. Both keys are',
  'required; unknown keys (including any confirmation_text_sha256 the model computes) are rejected.',
  'WITHOUT override: the four edges above are never skipped and every missing gate still BLOCKS.',
  'WITH override: all remaining gates up to S10 are treated as human-waived; the pointer advances',
  'one edge at a time to the furthest reachable stage (<= S10), every applied edge appears in',
  'transitions[], the waived edges are recorded, and a same-transaction audit event records the',
  'reason, who confirmed, when, the SHA-256 of the verbatim words, and from/to stage.',
  'override still refuses non-ACTIVE applications, stages outside S6..S10, and never regresses.',
  'Missing reason / confirmation_text, or a missing execution actor, fails closed with zero writes.',
].join(' ')

/**
 * 造一个可执行一次的返回值。
 * @param config - 已解析的库配置（租户/连接只从这里来）。
 * @param applicationId - 已校验的申请 id。
 * @param actorId - 本次写库的作者（Demo Actor 解析结果或测试兼容的 `config.actor_id`）。
 * @param override - AT-6/7 的人工原话授权；缺省 = 完全沿用原路径。
 * @param expectedRecordVersion - 可选乐观并发版本；缺省时**连输入对象的键都不多一个**，
 *   领域层看到的就是原来的 `{tenantId, applicationId}` / `{..., override}`。
 * @returns 规范输出值。
 */
async function runStageAdvance(
  config: ResolvedDatabaseConfig,
  applicationId: string,
  actorId: string,
  override?: StageOverride,
  expectedRecordVersion?: number,
): Promise<StageAdvanceValue> {
  const pool = createPool(config)
  try {
    return await withActor(pool, actorId, async (client) => {
      // 领域层只认"事实"；调用方只提供租户与申请 id（+ 可选的人工原话 override）。
      // 没传 expected_record_version 时用空展开 ⇒ 输入对象与改动前逐键一致（零行为漂移）。
      const versionGuard = expectedRecordVersion === undefined
        ? {}
        : { expected_record_version: expectedRecordVersion }
      const result = override === undefined
        ? await advanceApplicationStage(client, { tenantId: config.tenant_id, applicationId, ...versionGuard })
        : await advanceApplicationStageWithOverride(client, {
          tenantId: config.tenant_id,
          applicationId,
          override,
          ...versionGuard,
        })
      // R4：三维标签走**同一份判定实现**（candidate-get.ts 的 buildThreeAxisLabels），
      // 不在本文件另写一份（`test/unit/label-honesty.test.ts` 机检"单一实现"）。
      const labels = await buildThreeAxisLabels(client, config.tenant_id)
      return {
        tool: TOOL_NAME,
        contract_version: CONTRACT_VERSION,
        application_id: result.application_id,
        stage_code: result.stage_code,
        record_version: result.record_version,
        status: result.status,
        transitions: result.transitions,
        blockers: result.blockers,
        warnings: result.warnings,
        labels,
      }
    })
  } finally {
    await closePool(pool)
  }
}

/**
 * 造真实的阶段推进工具。
 * @param config - 已解析的库配置（模型无法传入租户/actor）。
 * @param deps - 可选依赖：`identity` 由 `src/index.ts` 装配（产品路径）；缺省 = 测试兼容。
 * @returns 工具定义。
 */
export function createStageAdvanceTool(
  config: ResolvedDatabaseConfig,
  deps: ToolActorDeps = {},
): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: stageAdvanceParameters(),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as StageAdvanceValue
        // O1 残留：人读正文只给业务标识（阶段码）与短号；完整 application_id 只进末尾的
        // machine arguments 区（模型要复制才能调下游工具）。
        const lines: string[] = [
          `${v.tool} ${v.contract_version}: ${v.status} 申请 ${shortRef(v.application_id)} `
            + `@ ${v.stage_code} (record_version=${v.record_version})`,
        ]
        if (v.transitions.length > 0) {
          lines.push(`  transitions: ${v.transitions.map((t) => `${t.from} -> ${t.to}`).join(', ')}`)
        }
        for (const blocker of v.blockers) {
          lines.push(
            `  blocker ${blocker.code} [owner=${blocker.owner_role}`
              + `${blocker.owner_actor_id === undefined ? '' : ` ${shortRef(blocker.owner_actor_id)}`}`
              + `${blocker.owner_display_name === undefined ? '' : ` ${blocker.owner_display_name}`}]`
              + ` next=${blocker.next_action_code}: ${blocker.message}`,
          )
        }
        for (const warning of v.warnings) {
          lines.push(
            `  warning ${warning.code} [owner=${warning.owner_role}`
              + `${warning.owner_actor_id === undefined ? '' : ` ${shortRef(warning.owner_actor_id)}`}]`
              + ` next=${warning.next_action_code}: ${warning.message}`,
          )
        }
        // 每次渲染都写一遍：审计里那一列是"执行账号"，不是"决策人"。
        lines.push('  stage_changed_by_actor_id = 执行账号（SET LOCAL recruitment.actor_id），不代表决策人；T1 是自动推进。')
        lines.push(`  labels: provenance=${v.labels.provenance} trigger=${v.labels.trigger} connection=${v.labels.connection}`)
        lines.push(...machineArgumentLines([{ key: 'application_id', value: v.application_id }]))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    // 写路径：与 intake / interview_schedule 一致，不允许与兄弟调用并行。
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // 写身份先于任何 DB 连接解析：identity 已装配时，缺失映射在开事务前 fail-closed（零写入）。
      const writeActor = resolveWriteActor(exec, deps.identity, config.actor_id)
      // AT-6/7：override 的严格校验也在开库之前完成（缺原话/未知键 → INVALID_ARGS，零写入）。
      const { rest, override } = splitOverrideArg(rawArgs)
      const args = parseArgs(PARAMS, rest)
      const applicationId = args.application_id as string
      // expected_record_version 在 PARAMS 里 ⇒ parseArgs 已做整数/≥1 校验，且它留在 args 里。
      const expectedRecordVersion = args.expected_record_version as number | undefined
      return await runStageAdvance(config, applicationId, writeActor.actor_id, override, expectedRecordVersion)
    },
  }
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED（列出缺什么）。
 * @param issues - 缺失的配置项。
 * @returns 调用即抛错的工具定义。
 */
export function unconfiguredStageAdvanceTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Advance one application\'s stage pointer by acknowledging facts that already happened '
      + '(S6->S7->S8->S9->S10; S10 is the v1.0 terminal stage; derived command, no new authority). '
      + `Currently NOT CONFIGURED: ${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: stageAdvanceParameters(),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError('NOT_CONFIGURED', issues.join('; '))
    },
  }
}
