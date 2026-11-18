// recruitment_candidate_constraint —— 候选人级碎片约束的**人工入口**（append-only）。
//
// 业务来源（docs/34 §2「碎片约束置顶 + 下一轮交接提醒」）：招聘里 HR / 面试官在对话里
// 说过一句"这个人务必安排 X 轮""上一轮问到 Y，下一轮接着问"是真实存在的事实；模型
// 只负责把它记下来，不替人判断、不重排约束。本工具只记录"人已经说过的话"。
//
// 六条不可协商的规则：
//   1. **入参封闭**：只允许 action / candidate_id / application_id / text / source /
//      interview_id。tenant_id / actor_id / created_by_actor_id / id / created_at /
//      record_version / superseded_by_constraint_id 等服务端派生或身份键一律拒收
//      （`INVALID_ARGS` + `reason_code=SERVER_DERIVED_REJECTED`，零写入）。
//   2. **按 action 的必填**：text / source（PIN、HANDOFF 必填）、interview_id（HANDOFF
//      必填）在 `parseToolArgs` 里提前校验（与 criterion-override 的 confirmation_text
//      同款做法；schema 的 required 只放 action，因为 toParameterSchema 的 required 是静态的）。
//      领域层 `parseCandidateConstraintArgs` 是同一批规则的唯一实现（R1）。
//   3. **写身份来自执行上下文**：`resolveWriteActor(exec, identity, legacyActorId)`；
//      identity 已装配但拿不到 session/绑定/映射 → `DEMO_ACTOR_UNMAPPED`（开事务之前，零写入）。
//      不接 approval：写的是人在对话里说的原话，人的闸门由 resolveWriteActor 保证，
//      必须记录 `created_by_actor_id = writeActor.actor_id`。
//   4. **同事务审计**：成功写入（含 supersede）后在同一事务写一条
//      `candidate.constraint.recorded`（名字只从 `EVENT_TYPES` 取）。幂等 no-op
//      （inserted=false）不写第二条事件。normalizer_version='schema/0001'。
//   5. **render 口径（O1）**：人读正文只给短号；完整 UUID 只在 machine arguments 区
//      （header 逐字含 'never show ids or hashes to the human'）。
//   6. **输出 schema 只用 DSH 子集**：无 type 数组、无 type:null；可空用空串表达。
//
// 事务边界：`withActor(pool, actorId, ...)` 内先 `resolveCandidateId` → `recordConstraint`
// / `recordUnpin` 写业务行，再写审计事件；任何一步失败都回滚。
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'

import { toParameterSchema, type ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { buildThreeAxisLabels, type ThreeAxisLabels } from './candidate-get.ts'
import { mapDatabaseError } from './job-create.ts'
import { machineArgumentLines, shortRef } from './render-ref.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'
import { EVENT_TYPES } from '../runtime/event-types.ts'
import {
  CONSTRAINT_ACTIONS,
  CONSTRAINT_KINDS,
  CONSTRAINT_SOURCES,
  MAX_CONSTRAINT_TEXT,
  parseCandidateConstraintArgs,
  type CandidateConstraintInput,
  type ConstraintAction,
  type ConstraintKind,
  type ConstraintSource,
} from '../domain/candidate-constraint.ts'
import {
  recordConstraint,
  recordUnpin,
  resolveCandidateId,
  type RecordConstraintResult,
} from '../db/candidate-constraint.ts'

/** 工具名（DSH 全局唯一；冻结；index.ts 注册 32→33）。 */
export const CANDIDATE_CONSTRAINT_TOOL = 'recruitment_candidate_constraint'
/** 出参契约版本（本工具基线）。 */
export const CONTRACT_VERSION = 'candidate-constraint 1.0.0'

/** reason_code 闭集（写进错误 detail，与 criterion-override.ts 的 REASON 同形）。 */
const REASON = {
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  SERVER_DERIVED_REJECTED: 'SERVER_DERIVED_REJECTED',
  UNKNOWN_PARAM: 'UNKNOWN_PARAM',
  ENUM_INVALID: 'ENUM_INVALID',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  ID_NOT_UUID: 'ID_NOT_UUID',
} as const

/**
 * 造 `Error: <CODE>: <compact-json>` 形态的工具错误（与 criterion-override.ts::toolError 同形）。
 * `SERVER_DERIVED_REJECTED` 等是 `INVALID_ARGS` 下的 reason_code，不扩顶层 code 闭集。
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
  action: {
    kind: 'string',
    required: true,
    values: [...CONSTRAINT_ACTIONS],
    description: 'One of PIN / UNPIN / HANDOFF. PIN pins a constraint; UNPIN removes the latest matching '
      + 'PIN (tombstone); HANDOFF leaves a reminder for the next interview round.',
  },
  candidate_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Candidate UUID. At least one of candidate_id / application_id is required; if both are '
      + 'given they must resolve to the same candidate.',
  },
  application_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Application UUID. Optional alternative to candidate_id; the candidate is resolved from it.',
  },
  text: {
    kind: 'string',
    maxLength: MAX_CONSTRAINT_TEXT,
    description: 'REQUIRED for PIN / HANDOFF: the human\'s verbatim words (non-empty, at most 500 chars). '
      + 'Optional for UNPIN (the latest matching PIN is removed when omitted).',
  },
  source: {
    kind: 'string',
    values: [...CONSTRAINT_SOURCES],
    description: 'REQUIRED for PIN / HANDOFF, optional for UNPIN: where the constraint was said '
      + '(CHAT / WEIXIN / PHONE / OTHER).',
  },
  interview_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'REQUIRED for HANDOFF: the interview this reminder is attached to (must belong to the '
      + 'same tenant / candidate chain).',
  },
}

/** 入参形状：解析并归一化为领域输入；任何拒绝都发生在建连/写库之前。 */
export interface CandidateConstraintToolArgs extends CandidateConstraintInput {}

/**
 * 严格解析工具入参：先拒未知键/服务端派生键/身份键，再按 action 校验必填，最后交给领域层
 * `parseCandidateConstraintArgs`（唯一规则实现）。
 * @param raw - 模型给的 arguments。
 * @returns 已校验的领域输入。
 * @throws RecruitmentToolError - `INVALID_ARGS`（零写入）。
 */
export function parseToolArgs(raw: unknown): CandidateConstraintToolArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw toolError('INVALID_ARGS', REASON.TYPE_MISMATCH, 'arguments 必须是 JSON 对象', { path: 'arguments' })
  }
  const input = raw as Record<string, unknown>
  const action = input.action

  // action 必填且闭集（schema 的 required 只放 action；其余必填按 action 在这里校验）。
  if (action === undefined || action === null) {
    throw toolError('INVALID_ARGS', REASON.MISSING_REQUIRED, '缺少 action（PIN / UNPIN / HANDOFF 之一）', {
      missing: ['action'],
    })
  }
  if (typeof action !== 'string' || !CONSTRAINT_ACTIONS.includes(action as ConstraintAction)) {
    throw toolError('INVALID_ARGS', REASON.ENUM_INVALID, `action 必须是 ${CONSTRAINT_ACTIONS.join(' / ')} 之一`, {
      path: 'action',
    })
  }
  const kind = action as ConstraintAction

  // 按 action 的必填：text / source（PIN、HANDOFF）、interview_id（HANDOFF）。
  // 领域层也会校验，这里提前拒是为了让 execute 入口的错误码稳定（与 confirmation_text 同款）。
  const missing: string[] = []
  if (kind !== 'UNPIN') {
    if (input.text === undefined || input.text === null) missing.push('text')
    if (input.source === undefined || input.source === null) missing.push('source')
    if (kind === 'HANDOFF' && (input.interview_id === undefined || input.interview_id === null)) {
      missing.push('interview_id')
    }
  }
  if (missing.length > 0) {
    throw toolError(
      'INVALID_ARGS',
      REASON.MISSING_REQUIRED,
      `${action} 缺少必填参数：${missing.join(', ')}，本次没有写任何行`,
      { missing },
    )
  }

  const parsed = parseCandidateConstraintArgs(raw)
  if (parsed.ok !== true) {
    throw toolError('INVALID_ARGS', parsed.reason_code, parsed.message, { path: 'arguments' })
  }
  return parsed.value
}

// ---------------------------------------------------------------------------
//  出参（结构化为约定）
// ---------------------------------------------------------------------------

/** 一次约束写入的规范出参（可空用空串表达）。 */
export interface CandidateConstraintValue {
  readonly tool: typeof CANDIDATE_CONSTRAINT_TOOL
  readonly contract_version: string
  readonly action: ConstraintAction
  readonly candidate_id: string
  readonly constraint_id: string
  readonly superseded_id: string
  readonly inserted: boolean
  readonly text: string
  readonly source: string
  readonly created_by: string
  readonly created_at: string
  readonly labels: ThreeAxisLabels
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: [CANDIDATE_CONSTRAINT_TOOL] },
    contract_version: { type: 'string' },
    action: { type: 'string', enum: [...CONSTRAINT_ACTIONS] },
    candidate_id: { type: 'string' },
    constraint_id: { type: 'string' },
    superseded_id: { type: 'string' },
    inserted: { type: 'boolean' },
    text: { type: 'string' },
    source: { type: 'string' },
    created_by: { type: 'string' },
    created_at: { type: 'string' },
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
  // 可空的 superseded_id / text / source 在值里用空串表达（DSH schema 不允许 type:null / null 值）。
  required: [
    'tool', 'contract_version', 'action', 'candidate_id', 'constraint_id', 'superseded_id',
    'inserted', 'text', 'source', 'created_by', 'created_at', 'labels',
  ],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
//  审计事件（同事务）
// ---------------------------------------------------------------------------

/**
 * 写一条内部审计事件（`event_inbox`）。名字取自 `EVENT_TYPES`，不在发射点写裸字面量。
 * @returns 新事件 id。
 */
async function insertConstraintRecordedEvent(
  client: DatabaseClient,
  input: {
    readonly tenantId: string
    readonly candidateId: string
    readonly action: string
    readonly kind: ConstraintKind
    readonly text: string
    readonly source: string
    readonly actorId: string
    readonly constraintId: string
    readonly inserted: boolean
  },
): Promise<string> {
  const payload = {
    candidate_id: input.candidateId,
    kind: input.kind,
    text: input.text,
    source: input.source,
    actor_id: input.actorId,
    action: input.action,
    inserted: input.inserted,
    constraint_id: input.constraintId,
  }
  const { rows } = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
        (tenant_id, provider, provider_event_id, event_type, schema_version,
         occurred_at, received_at, recorded_at, correlation_id, causation_id,
         idempotency_key, idempotency_source, source_object_id,
         payload_ref, payload, trust_level, normalized_event_type, normalizer_version)
     values ($1, 'internal', null, '${EVENT_TYPES.CANDIDATE_CONSTRAINT_RECORDED}', 1,
             now(), now(), now(), null, null,
             $2, 'FALLBACK_KEY', $3,
             null, $4::jsonb, 'INTERNAL', '${EVENT_TYPES.CANDIDATE_CONSTRAINT_RECORDED}', 'schema/0001')
     returning event_id`,
    [
      input.tenantId,
      `candidate-constraint:${randomUUID()}`,
      input.constraintId,
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
export interface CandidateConstraintDeps extends ToolActorDeps {
  readonly database: ResolvedDatabaseConfig
}

/**
 * 在调用方给的事务里记录一条候选人约束。
 *
 * 顺序：入参校验（纯函数、最早拒）→ `resolveCandidateId` → 按 action 调
 * `recordConstraint` / `recordUnpin` → 写一条审计事件（仅 inserted=true）。
 * @param client - `withActor` 事务内客户端（GUC 已 SET LOCAL）。
 * @param deps - 库配置 + identity。
 * @param actorId - 已解析的写身份（来自执行上下文，非模型入参）。
 * @param rawArgs - 模型给的 arguments（本函数再校验一次，保证直调也安全）。
 * @returns 契约出参。
 */
export async function recordCandidateConstraintInTransaction(
  client: DatabaseClient,
  deps: CandidateConstraintDeps,
  actorId: string,
  rawArgs: unknown,
): Promise<CandidateConstraintValue> {
  const args = parseToolArgs(rawArgs)
  const tenantId = deps.database.tenant_id
  const labels = await buildThreeAxisLabels(client, tenantId)

  const candidateId = await resolveCandidateId(client, tenantId, {
    candidate_id: args.candidate_id,
    application_id: args.application_id ?? null,
  })

  let written: RecordConstraintResult
  let kind: ConstraintKind
  let text = ''
  let source = ''
  if (args.action === 'UNPIN') {
    kind = 'PIN'
    text = args.text ?? ''
    source = args.source ?? ''
    written = await recordUnpin(client, {
      tenant_id: tenantId,
      candidate_id: args.candidate_id,
      application_id: args.application_id ?? null,
      ...(args.text === undefined ? {} : { text: args.text }),
      ...(args.source === undefined ? {} : { source: args.source }),
      created_by_actor_id: actorId,
    })
  } else {
    kind = args.action
    text = args.text ?? ''
    source = args.source ?? ''
    written = await recordConstraint(client, {
      tenant_id: tenantId,
      candidate_id: args.candidate_id,
      application_id: args.application_id ?? null,
      kind: args.action,
      text: args.text ?? '',
      source: args.source ?? 'OTHER',
      ...(args.interview_id === undefined ? {} : { interview_id: args.interview_id }),
      created_by_actor_id: actorId,
    })
  }

  if (written.inserted) {
    await insertConstraintRecordedEvent(client, {
      tenantId,
      candidateId,
      action: args.action,
      kind,
      text,
      source,
      actorId,
      constraintId: written.constraint_id,
      inserted: written.inserted,
    })
  }

  const created = await readConstraintById(client, tenantId, written.constraint_id)
  return {
    tool: CANDIDATE_CONSTRAINT_TOOL,
    contract_version: CONTRACT_VERSION,
    action: args.action,
    candidate_id: candidateId,
    constraint_id: written.constraint_id,
    superseded_id: written.superseded_id ?? '',
    inserted: written.inserted,
    text,
    source,
    created_by: created?.created_by_actor_id ?? actorId,
    created_at: created === undefined ? '' : isoDate(created.created_at),
    labels,
  }
}

/** 幂等 no-op / 墓碑出参要读回真实 created_by / created_at（不编造）。 */
async function readConstraintById(
  client: DatabaseClient,
  tenantId: string,
  constraintId: string,
): Promise<{ created_by_actor_id: string; created_at: Date | string } | undefined> {
  const { rows } = await client.query<{ created_by_actor_id: string; created_at: Date | string }>(
    `select created_by_actor_id, created_at from recruitment.candidate_constraint
      where tenant_id = $1 and id = $2`,
    [tenantId, constraintId],
  )
  return rows[0]
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/** 模型可见说明（写进 tool description）。 */
const DESCRIPTION = [
  'Record a human-stated candidate constraint (append-only): PIN / UNPIN / HANDOFF.',
  'PIN pins a verbatim constraint for the candidate; different texts coexist and are ordered by time. '
  + 'Re-pinning the same text+source is an idempotent no-op.',
  'UNPIN removes the latest matching PIN by writing a tombstone (the history stays queryable). '
  + 'text/source are optional for UNPIN; without them the latest current PIN is removed.',
  'HANDOFF leaves a reminder for the next interview round: interview_id is REQUIRED and must belong to '
  + 'the same tenant / candidate chain. text and source are REQUIRED for PIN / HANDOFF.',
  'Do NOT pass tenant_id, actor_id, created_by_actor_id, id, created_at, record_version or '
  + 'superseded_by_constraint_id — those are server-derived and are rejected.',
  'Verify the result with recruitment_application_get (constraints.pins / constraints.handoffs).',
].join('\n')

/**
 * 造真实的候选人约束工具（写路径；`isConcurrencySafe=false`）。
 * @param deps - 库配置 + 可选 Demo Actor 身份（产品路径由 index.ts 装配）。
 */
export function createCandidateConstraintTool(deps: CandidateConstraintDeps): ReadonlyToolDefinition {
  return {
    name: CANDIDATE_CONSTRAINT_TOOL,
    description: DESCRIPTION,
    parameters: toParameterSchema(PARAMS),
    output: { schema: OUTPUT_SCHEMA, render: renderCandidateConstraintValue },
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
          async (client) => recordCandidateConstraintInTransaction(
            client, { ...deps, database: writeConfig }, writeActor.actor_id, rawArgs,
          ),
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
export function unconfiguredCandidateConstraintTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: CANDIDATE_CONSTRAINT_TOOL,
    description: `${DESCRIPTION}\n\nCurrently NOT CONFIGURED: the plugin config is missing database `
      + `settings (or the database password environment variable). Calls return NOT_CONFIGURED.`,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${CANDIDATE_CONSTRAINT_TOOL} is not configured: ${issues.join('; ')}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(): Promise<unknown> {
      throw toolError('NOT_CONFIGURED', 'PLUGIN_NOT_CONFIGURED', '数据库配置不完整，候选人约束不可用', {
        issues: [...issues],
      })
    },
  }
}

/** 模型可见文本：回显约束事实与读回工具（签名必须是 `(args, value)`）。 */
export function renderCandidateConstraintValue(_args: unknown, value: unknown): readonly TextBlock[] {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<CandidateConstraintValue>
  const lines = [
    `${CANDIDATE_CONSTRAINT_TOOL}: ${v.inserted === true ? 'recorded' : 'no-op (already pinned)'}`,
    `action: ${v.action ?? ''}`,
    `candidate: ${shortRef(v.candidate_id ?? null)}`,
    `text: ${v.text ?? ''}`,
    `source: ${v.source ?? ''}`,
    `constraint: ${shortRef(v.constraint_id ?? null)}`,
    ...(v.superseded_id ? [`superseded: ${shortRef(v.superseded_id)}`] : []),
    '',
    'Verify with recruitment_application_get (constraints.pins / constraints.handoffs).',
    // 完整 id 只在机器参数区（模型复制去调下游工具，绝不给人看）。
    ...machineArgumentLines([
      { key: 'candidate_id', value: v.candidate_id ?? '' },
      { key: 'constraint_id', value: v.constraint_id ?? '' },
    ]),
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}
