// recruitment_criterion_override —— 逐条 rubric 标准的**人工纠偏入口**（append-only）。
//
// 业务来源（为什么是人的动作）：招聘里"AI 对某一条标准判错了、HR 手工改过来"是真实存在的动作；
// 它必须由人做、且必须有原话凭据才能落库。本工具只记录"人已经说过的话"，不替人判断、
// 不重算 AI 判断、不改 rubric 版本定义。
//
// 五条不可协商的规则：
//   1. **入参封闭**：只允许 application_id / criterion_key / human_state / note / confirmation_text。
//      actor_id / tenant_id / confirmation_text_sha256 / confirmation_method / record_version / id
//      等服务端派生或身份键一律拒收（`INVALID_ARGS` + `reason_code=SERVER_DERIVED_REJECTED`，零写入）。
//   2. **原话必填**：`confirmation_text` 是人在对话里说过的原话（"我说这条应该是 PRESENT……"），
//      非空；服务端用 `sha256Text()` 算摘要落库，**不接受调用方传 hash**。缺原话 →
//      `INVALID_ARGS`（reason_code=MISSING_REQUIRED），零写入。
//   3. **标准必须属于申请钉住的 rubric**：`recordOverride()` 在事务内部按 application 的 pinned
//      rubric 校验 criterion_key；不在其中 → `INVALID_ARGS` + `reason_code=CRITERION_NOT_IN_RUBRIC`，
//      整事务回滚（零写入）。
//   4. **写身份来自执行上下文**：`resolveWriteActor(exec, identity, legacyActorId)`；identity 已装配
//      但拿不到 session/绑定/映射 → `DEMO_ACTOR_UNMAPPED`（开事务之前，零写入）。
//   5. **一条审计事件**：成功插入（含 supersede）后在**同一事务**写一条 `criterion.override.recorded`
//      （名字只从 `src/runtime/event-types.ts` 的 `EVENT_TYPES` 取）；normalizer_version='schema/0001'
//      与 job.rubric_version.approved / interview.record.verified 同一口径，注册表显式登记为 IGNORED。
//      幂等 no-op（重复纠偏）由 `recordOverride()` 判 `inserted=false`；不写第二条事件。
//
// 事务边界：`withActor(pool, actorId, ...)` 内先 `recordOverride()` 写业务行，再写审计事件；
// 任何一步失败都回滚，绝不留"纠偏落了、审计没写"的半状态。
// 输出 schema 只用 DSH 子集（test/unit/output-schema.test.ts 口径）：无 type 数组、无 type:null。

import { randomUUID } from 'node:crypto'

import { toParameterSchema, type ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { buildThreeAxisLabels, type ThreeAxisLabels } from './candidate-get.ts'
import { mapDatabaseError } from './job-create.ts'
// render 口径（O1）：人读正文只放短号；完整 id 只能进 machine arguments 区。
import { machineArgumentLines, shortHash, shortRef } from './render-ref.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'
// 事件名只从注册表取（`src/runtime/event-types.ts`）；机检测试会扫发射点。
import { EVENT_TYPES } from '../runtime/event-types.ts'
import {
  HUMAN_STATES,
  parseCriterionOverrideArgs,
  sha256Text,
  effectiveState,
  type CriterionOverrideInput,
  type HumanState,
} from '../domain/criterion-override.ts'
import { recordOverride, type CriterionOverrideRow } from '../db/criterion-override.ts'

/** 工具名（DSH 全局唯一；冻结）。 */
export const CRITERION_OVERRIDE_TOOL = 'recruitment_criterion_override'
/** 出参契约版本（本工具基线）。 */
export const CONTRACT_VERSION = 'criterion-override 1.0.0'
/** 人工确认方式：本工具的入参原话即人在对话里的确认，恒 IN_CHAT。 */
const CONFIRMATION_METHOD = 'IN_CHAT' as const

/** reason_code 闭集（写进错误 detail，与 record_human_decision.ts 的 REASON 同形）。 */
const REASON = {
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  SERVER_DERIVED_REJECTED: 'SERVER_DERIVED_REJECTED',
  UNKNOWN_PARAM: 'UNKNOWN_PARAM',
  TENANT_OR_ACTOR_NOT_ALLOWED: 'TENANT_OR_ACTOR_NOT_ALLOWED',
  ENUM_INVALID: 'ENUM_INVALID',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  ID_NOT_UUID: 'ID_NOT_UUID',
} as const

/**
 * 造 `Error: <CODE>: <compact-json>` 形态的工具错误（与 record_human_decision.ts::toolError 同形）。
 * `SERVER_DERIVED_REJECTED` / `CRITERION_NOT_IN_RUBRIC` 都是 `INVALID_ARGS` 下的 reason_code，
 * 不是新的顶层 code（`RecruitmentErrorCode` 是闭集，不在本文件扩张）。
 */
function toolError(
  code: 'INVALID_ARGS' | 'DEMO_ACTOR_UNMAPPED' | 'NOT_CONFIGURED',
  reasonCode: string,
  message: string,
  detail?: unknown,
): RecruitmentToolError {
  const body: Record<string, unknown> = { code, reason_code: reasonCode, message }
  if (detail !== undefined) body.detail = detail
  return new RecruitmentToolError(code, JSON.stringify(body))
}

// ---------------------------------------------------------------------------
//  入参（封闭对象根；tenant_id / actor_id / 服务端派生键都不接受）
// ---------------------------------------------------------------------------

const PARAMS: ParamMap = {
  application_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Application id (UUID). The criterion is validated against the rubric pinned by this application.',
  },
  criterion_key: {
    kind: 'string',
    required: true,
    maxLength: 200,
    description: 'Criterion key from the pinned rubric (non-empty, at most 200 characters). '
      + 'A key not in that rubric is rejected with CRITERION_NOT_IN_RUBRIC and writes nothing.',
  },
  human_state: {
    kind: 'string',
    required: true,
    values: [...HUMAN_STATES],
    description: 'Human judgment for this criterion: PRESENT / ABSENT / UNREADABLE. Human wins over the AI state.',
  },
  note: {
    kind: 'string',
    maxLength: 2000,
    description: 'Optional human note (at most 2000 characters). Stored on the override row, not on the audit event.',
  },
  confirmation_text: {
    kind: 'string',
    required: true,
    maxLength: 2000,
    description: 'REQUIRED: the human\'s verbatim words confirming this override (non-empty, at most 2000 '
      + 'characters). The server hashes this text (sha256) and stores the digest; never send a precomputed hash.',
  },
}

/** 服务端派生 / 身份键：命中一律 `SERVER_DERIVED_REJECTED`（与 record_human_decision.ts 同口径）。 */
const SERVER_DERIVED_KEYS: ReadonlySet<string> = new Set([
  'actor_id', 'tenant_id', 'confirmation_text_sha256', 'confirmation_method',
  'record_version', 'id', 'rubric_version_id', 'superseded_by_override_id',
  'created_at', 'updated_at', 'actor_id', 'confirmation_text_sha256',
])

/** 入参形状：解析并归一化为领域输入；任何拒绝都发生在建连/写库之前。 */
export interface CriterionOverrideToolArgs extends CriterionOverrideInput {}

/**
 * 严格解析工具入参：先拒未知键/服务端派生键/身份键，再交给领域层 `parseCriterionOverrideArgs`。
 * @param raw - 模型给的 arguments。
 * @returns 已校验的领域输入。
 * @throws RecruitmentToolError - `INVALID_ARGS`（零写入）。
 */
export function parseToolArgs(raw: unknown): CriterionOverrideToolArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw toolError('INVALID_ARGS', REASON.TYPE_MISMATCH, 'arguments 必须是 JSON 对象', { path: 'arguments' })
  }
  const input = raw as Record<string, unknown>
  const declared = Object.keys(PARAMS)
  const rejectedDerived: string[] = []
  const rejectedIdentity: string[] = []
  const unknown: string[] = []
  for (const key of Object.keys(input).sort()) {
    if (SERVER_DERIVED_KEYS.has(key)) rejectedDerived.push(key)
    else if (key === 'tenant_id' || key === 'actor_id') rejectedIdentity.push(key)
    else if (!declared.includes(key)) unknown.push(key)
  }
  if (rejectedDerived.length > 0) {
    throw toolError(
      'INVALID_ARGS',
      REASON.SERVER_DERIVED_REJECTED,
      `${rejectedDerived.join(', ')} 由服务端派生，调用方不得传入（confirmation_text_sha256 由 sha256(confirmation_text) 算出）`,
      { rejected: rejectedDerived, reason_code: 'SERVER_DERIVED_REJECTED' },
    )
  }
  if (rejectedIdentity.length > 0) {
    throw toolError(
      'INVALID_ARGS',
      REASON.TENANT_OR_ACTOR_NOT_ALLOWED,
      `${rejectedIdentity.join(', ')} 只能来自执行上下文，不接受入参`,
      { rejected: rejectedIdentity },
    )
  }
  if (unknown.length > 0) {
    throw toolError('INVALID_ARGS', REASON.UNKNOWN_PARAM, `未知参数 ${unknown.join(', ')}`, {
      unknown_keys: unknown,
      allowed: declared,
    })
  }
  // 必填缺项：confirmation_text 缺失单独报 MISSING_REQUIRED（任务书明确要求）。
  if (input.confirmation_text === undefined) {
    throw toolError(
      'INVALID_ARGS',
      REASON.MISSING_REQUIRED,
      '缺少 confirmation_text：必须给出人的原话（服务端据此算 sha256），本次没有写任何行',
      { missing: ['confirmation_text'] },
    )
  }
  const parsed = parseCriterionOverrideArgs(raw)
  if (parsed.ok !== true) {
    throw toolError('INVALID_ARGS', parsed.reason_code, parsed.message, { path: 'arguments' })
  }
  return parsed.value
}

// ---------------------------------------------------------------------------
//  出参（结构化为约定）
// ---------------------------------------------------------------------------

/** 一次纠偏的规范出参。 */
export interface CriterionOverrideValue {
  readonly tool: typeof CRITERION_OVERRIDE_TOOL
  readonly contract_version: string
  readonly application_id: string
  readonly criterion_key: string
  readonly human_state: HumanState
  readonly effective_state: string | null
  readonly override_id: string
  readonly superseded_id: string | null
  readonly inserted: boolean
  readonly confirmation_method: typeof CONFIRMATION_METHOD
  readonly confirmation_text_sha256: string
  readonly actor_id: string
  readonly labels: ThreeAxisLabels
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: [CRITERION_OVERRIDE_TOOL] },
    contract_version: { type: 'string' },
    application_id: { type: 'string' },
    criterion_key: { type: 'string' },
    human_state: { type: 'string', enum: [...HUMAN_STATES] },
    effective_state: { type: 'string' },
    override_id: { type: 'string' },
    superseded_id: { type: 'string' },
    inserted: { type: 'boolean' },
    confirmation_method: { type: 'string', enum: [CONFIRMATION_METHOD] },
    confirmation_text_sha256: { type: 'string' },
    actor_id: { type: 'string' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED', 'NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
  },
  // 可空的 effective_state/superseded_id 在值里用空串表达（DSH schema 不允许 type:null / null 值），
  // 这与 decision-record.ts 的 stripNulls 口径一致：键恒在、空串 = 没有。
  required: [
    'tool', 'contract_version', 'application_id', 'criterion_key', 'human_state',
    'effective_state', 'override_id', 'superseded_id', 'inserted',
    'confirmation_method', 'confirmation_text_sha256', 'actor_id', 'labels',
  ],
  additionalProperties: false,
}

/**
 * 写一条内部审计事件（`event_inbox`）。名字取自 `EVENT_TYPES`，不在发射点写裸字面量。
 * @returns 新事件 id。
 */
async function insertOverrideRecordedEvent(
  client: DatabaseClient,
  input: {
    readonly tenantId: string
    readonly applicationId: string
    readonly criterionKey: string
    readonly humanState: string
    readonly effectiveState: string
    readonly overrideId: string
    readonly supersededId: string
    readonly confirmationMethod: typeof CONFIRMATION_METHOD
    readonly confirmationTextSha256: string
    readonly actorId: string
  },
): Promise<string> {
  const payload = {
    application_id: input.applicationId,
    criterion_key: input.criterionKey,
    human_state: input.humanState,
    effective_state: input.effectiveState,
    override_id: input.overrideId,
    superseded_id: input.supersededId,
    confirmation_method: input.confirmationMethod,
    confirmation_text_sha256: input.confirmationTextSha256,
    actor_id: input.actorId,
    source: CRITERION_OVERRIDE_TOOL,
  }
  const { rows } = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, provider_event_id, event_type, schema_version,
        occurred_at, received_at, recorded_at, correlation_id, causation_id,
        idempotency_key, idempotency_source, source_object_id,
        payload_ref, payload, trust_level, normalized_event_type, normalizer_version)
     values ($1, 'internal', null, '${EVENT_TYPES.CRITERION_OVERRIDE_RECORDED}', 1,
             now(), now(), now(), null, null,
             $2, 'FALLBACK_KEY', $3,
             null, $4::jsonb, 'INTERNAL', '${EVENT_TYPES.CRITERION_OVERRIDE_RECORDED}', 'schema/0001')
     returning event_id`,
    [
      input.tenantId,
      `criterion-override:${randomUUID()}`,
      input.overrideId,
      JSON.stringify(payload),
    ],
  )
  const eventId = rows[0]?.event_id
  if (eventId === undefined) throw new RecruitmentToolError('READER_FAILED', 'event_inbox insert returned no id')
  return eventId
}

// ---------------------------------------------------------------------------
//  事务核心（单独导出：集成测试可在必回滚事务里直调）
// ---------------------------------------------------------------------------

/** 事务核心的依赖：库配置 + 写身份（identity 由 `src/index.ts` 装配）。 */
export interface CriterionOverrideDeps extends ToolActorDeps {
  readonly database: ResolvedDatabaseConfig
}

/**
 * 在调用方给的事务里记录一次人工纠偏。
 *
 * 顺序：入参校验（纯函数、最早拒）→ `recordOverride()`（内部校验标准属于钉住 rubric；
 * 同事务把旧 current 收口；幂等 no-op 由返回值表达）→ 写一条审计事件（仅 inserted=true）。
 * @param client - `withActor` 事务内客户端（GUC 已 SET LOCAL）。
 * @param deps - 库配置 + identity。
 * @param actorId - 已解析的写身份（来自执行上下文，非模型入参）。
 * @param rawArgs - 模型给的 arguments（本函数再校验一次，保证直调也安全）。
 * @returns 契约出参。
 */
export async function recordCriterionOverrideInTransaction(
  client: DatabaseClient,
  deps: CriterionOverrideDeps,
  actorId: string,
  rawArgs: unknown,
): Promise<CriterionOverrideValue> {
  const args = parseToolArgs(rawArgs)
  const tenantId = deps.database.tenant_id
  const confirmationTextSha256 = sha256Text(args.confirmation_text)
  const labels = await buildThreeAxisLabels(client, tenantId)

  // recordOverride 内部：校验 application/pinned rubric/criterion，校验失败抛
  // RecruitmentToolError('INVALID_ARGS', detail.reason_code=CRITERION_NOT_IN_RUBRIC|APPLICATION_NOT_FOUND|NO_PINNED_RUBRIC)，
  // 处理幂等 no-op 与 supersede。任何抛出都让整个事务回滚（零写入）。
  const written = await recordOverride(client, {
    tenant_id: tenantId,
    application_id: args.application_id,
    criterion_key: args.criterion_key,
    human_state: args.human_state,
    note: args.note,
    actor_id: actorId,
    confirmation_text_sha256: confirmationTextSha256,
    confirmation_text: args.confirmation_text,
  })

  const current = await readCurrentOverride(client, tenantId, args.application_id, args.criterion_key)
  // AI per-criterion 状态目前没有落库列：effectiveState(null, human) = human。
  // 若将来有 AI 状态列，在这里传入即可；本工具不编造 AI 判断。
  const effective = effectiveState(null, args.human_state) ?? ''
  if (written.inserted) {
    await insertOverrideRecordedEvent(client, {
      tenantId,
      applicationId: args.application_id,
      criterionKey: args.criterion_key,
      humanState: args.human_state,
      effectiveState: effective,
      overrideId: written.override_id,
      supersededId: written.superseded_id ?? '',
      confirmationMethod: CONFIRMATION_METHOD,
      confirmationTextSha256,
      actorId,
    })
  }
  return {
    tool: CRITERION_OVERRIDE_TOOL,
    contract_version: CONTRACT_VERSION,
    application_id: args.application_id,
    criterion_key: args.criterion_key,
    human_state: args.human_state,
    effective_state: current?.human_state != null ? (effectiveState(null, current.human_state) ?? '') : effective,
    override_id: written.override_id,
    superseded_id: written.superseded_id ?? '',
    inserted: written.inserted,
    confirmation_method: CONFIRMATION_METHOD,
    confirmation_text_sha256: confirmationTextSha256,
    actor_id: actorId,
    labels,
  }
}

/** 幂等 no-op 时读回 current 行，确保出参里的 effective_state 反映库真值。 */
async function readCurrentOverride(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  criterionKey: string,
): Promise<CriterionOverrideRow | undefined> {
  const { rows } = await client.query<CriterionOverrideRow>(
    `select * from recruitment.criterion_override
      where tenant_id = $1 and application_id = $2 and criterion_key = $3
        and superseded_by_override_id is null
      order by created_at desc, id desc
      limit 1`,
    [tenantId, applicationId, criterionKey],
  )
  return rows[0]
}

/** 模型可见说明（写进 tool description）。 */
const DESCRIPTION = [
  'Record a human override of ONE rubric criterion for an application (append-only).',
  'The criterion_key must exist in the rubric pinned by that application; otherwise the call fails with '
  + 'CRITERION_NOT_IN_RUBRIC and writes nothing.',
  'confirmation_text is REQUIRED: the human\'s verbatim words confirming the change; the server computes its '
  + 'sha256 digest. Do NOT pass actor_id, tenant_id, confirmation_text_sha256, confirmation_method, id or '
  + 'record_version — those are server-derived and are rejected.',
  'human_state is one of PRESENT / ABSENT / UNREADABLE and wins over the AI judgment in read projections.',
  'Re-recording the same state is an idempotent no-op; superseding writes a new current row and closes the old one.',
  'Verify the result with recruitment_application_get (rubric.criteria_summary[].human_state / effective_state).',
].join('\n')

/**
 * 造真实的人工纠偏工具（写路径；`isConcurrencySafe=false`）。
 * @param deps - 库配置 + 可选 Demo Actor 身份（产品路径由 index.ts 装配）。
 */
export function createCriterionOverrideTool(deps: CriterionOverrideDeps): ReadonlyToolDefinition {
  return {
    name: CRITERION_OVERRIDE_TOOL,
    description: DESCRIPTION,
    parameters: toParameterSchema(PARAMS),
    output: { schema: OUTPUT_SCHEMA, render: renderCriterionOverrideValue },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // 1) 入参形状（不碰库；服务端派生键在这里就被拒，零写入）。
      parseToolArgs(rawArgs)
      // 2) 写身份先于建连解析：identity 已装配时缺失映射在此 fail-closed（零写入）。
      const writeActor = resolveWriteActor(exec, deps.identity, deps.database.actor_id)
      const writeConfig: ResolvedDatabaseConfig = { ...deps.database, actor_id: writeActor.actor_id }
      const pool = createPool(deps.database)
      try {
        return await withActor(
          pool,
          writeActor.actor_id,
          async (client) => recordCriterionOverrideInTransaction(client, { ...deps, database: writeConfig }, writeActor.actor_id, rawArgs),
        )
      } catch (error) {
        throw mapDatabaseError(error)
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 配置不完整时用的替身：注册同名工具，调用即 `NOT_CONFIGURED`（schema 仍是同一个封闭对象）。
 * @param issues - 缺哪些配置（值里永远不含密码）。
 */
export function unconfiguredCriterionOverrideTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: CRITERION_OVERRIDE_TOOL,
    description: `${DESCRIPTION}\n\nCurrently NOT CONFIGURED: the plugin config is missing database `
      + `settings (or the database password environment variable). Calls return NOT_CONFIGURED.`,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${CRITERION_OVERRIDE_TOOL} is not configured: ${issues.join('; ')}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(): Promise<unknown> {
      throw toolError('NOT_CONFIGURED', 'PLUGIN_NOT_CONFIGURED', '数据库配置不完整，人工纠偏不可用', {
        issues: [...issues],
      })
    },
  }
}

/** 模型可见文本：回显纠偏事实与读回工具（签名必须是 `(args, value)`）。 */
export function renderCriterionOverrideValue(_args: unknown, value: unknown): readonly TextBlock[] {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<CriterionOverrideValue>
  const lines = [
    `${CRITERION_OVERRIDE_TOOL}: ${v.inserted === true ? 'recorded' : 'no-op (already current)'}`,
    `application: ${shortRef(v.application_id ?? null)}`,
    `criterion: ${v.criterion_key ?? ''}`,
    `human_state: ${v.human_state ?? ''}`,
    `effective_state: ${v.effective_state ?? ''}`,
    `confirmation_method: ${v.confirmation_method ?? CONFIRMATION_METHOD}`,
    `confirmation_sha256: ${shortHash(v.confirmation_text_sha256 ?? null)}`,
    `override: ${shortRef(v.override_id ?? null)}`,
    ...(v.superseded_id ? [`superseded: ${shortRef(v.superseded_id)}`] : []),
    '',
    'Verify with recruitment_application_get (rubric.criteria_summary).',
    // 完整 id 只在机器参数区（模型复制去调下游工具，绝不给人看）。
    ...machineArgumentLines([
      { key: 'application_id', value: v.application_id ?? '' },
      { key: 'override_id', value: v.override_id ?? '' },
    ]),
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}
