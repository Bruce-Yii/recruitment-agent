// 写入口可选乐观锁（docs/34 §1.2 / LOCK-1 / LOCK-2）的**专用单元证据**。
//
// 三条硬语义（逐条钉死，不许放宽）：
//   LOCK-1 传旧版本 → 409 VERSION_CONFLICT/STALE_RECORD_VERSION，零写入、零审计事件；
//   LOCK-2 不传版本 → 与改动前逐字一致（零额外查询、零额外 WHERE、零新事件）；
//   传对版本 → 成功推进；守卫本身不写库、不令 record_version +1（B 式 FOR UPDATE）。
//
// 为什么用"记录所有 query 的假 client"：真库集成另由 owner 的独立 psql 读回给出；
// 这里能逐条断言**发了几条 SQL、SQL 文本里有没有 for update / record_version 谓词**
// —— 这正是"不是读回来再比两步法"的可执行证据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DatabaseClient } from '../../src/db/pool.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import { advanceApplicationStage } from '../../src/domain/stage-advance.ts'
import { createStageAdvanceTool } from '../../src/tools/stage-advance.ts'
import { createDecisionRecordTool, parseDecisionArgs } from '../../src/tools/decision-record.ts'
import { closeJobInTransaction, JOB_CLOSE_PATH } from '../../src/http/actions-job.ts'

const APP_ID = '11111111-1111-4111-8111-000000000701'
const TENANT = '11111111-1111-4111-8111-000000000001'
const ACTOR = '11111111-1111-4111-8111-000000000103'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const CREATED_US = Date.parse('2026-11-14T00:00:00.000Z') * 1000
const STAGE_ORDERS = [
  { code: 'S1', sort_order: 1, name: '招聘需求发现' }, { code: 'S2', sort_order: 2, name: 'Requisition 创建与审批' },
  { code: 'S3', sort_order: 3, name: 'Job / JD / Rubric 设计' }, { code: 'S4', sort_order: 4, name: 'Job Posting 发布' },
  { code: 'S5', sort_order: 5, name: '人才获取 / Sourcing' }, { code: 'S6', sort_order: 6, name: '简历接入与处理（Intake）' },
  { code: 'S7', sort_order: 7, name: '初筛 / Screening' }, { code: 'S8', sort_order: 8, name: '面试规划与排期' },
  { code: 'S9', sort_order: 9, name: '面试执行与材料获取' }, { code: 'S10', sort_order: 10, name: '综合评价与招聘决策' },
  { code: 'S11', sort_order: 11, name: 'Offer 与入职交接' }, { code: 'S12', sort_order: 12, name: '人才沉淀与复盘' },
]

const CFG = {
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: 'unused-in-this-test', password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT, actor_id: ACTOR, statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000, max: 2,
} as ResolvedDatabaseConfig

// =====================================================================
//  假 client：把每条 SQL 与参数原样记下来；只回答断言需要的那几条查询
// =====================================================================

interface Call { readonly text: string; readonly params: readonly unknown[] }

function recorder(handlers: {
  /** 申请行（diagnose 的锁读 / 守卫的 for update 读共用同一行）。 */
  readonly app?: Record<string, unknown> | null
  /** 让守卫的 for update 读到**不同**版本（造冲突）。 */
  readonly guardActualVersion?: number
  readonly onQuery?: (call: Call, calls: Call[]) => { rows: unknown[] } | undefined
}): DatabaseClient & { readonly calls: Call[] } {
  const calls: Call[] = []
  const client = {
    calls,
    async query(text: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
      const call: Call = { text, params }
      calls.push(call)
      const custom = handlers.onQuery?.(call, calls)
      if (custom !== undefined) return custom
      // 守卫：select a.record_version … for update（在 diagnose 之前）；用 SQL 文本精确区分，
      // 不能让它吃掉 diagnose 的 `select id, current_stage_code, … for update`。
      if (text.includes('for update') && text.includes('recruitment.application')
          && text.trimStart().startsWith('select a.record_version')) {
        const v = handlers.guardActualVersion
        return { rows: handlers.app === null || handlers.app === undefined
          ? []
          : [{ record_version: v ?? (handlers.app as { record_version: number }).record_version }] }
      }
      // diagnose 的申请读（含 stage_entered_at）
      if (text.includes('from recruitment.application') && text.includes('stage_entered_at')) {
        return { rows: handlers.app === null || handlers.app === undefined ? [] : [handlers.app] }
      }
      if (text.includes('hiring_manager_actor_id')) return { rows: [{ actor_id: null, display_name: null }] }
      if (text.includes('recruitment.stage_catalog')) return { rows: [...STAGE_ORDERS] }
      if (text.includes('recruitment.resume_version')) return { rows: [{ parse_status: 'PARSED' }] }
      if (text.includes('recruitment.scorecard')) return { rows: [] }
      if (text.includes('current_setting(')) return { rows: [{ actor_id: ACTOR }] }
      if (text.trimStart().startsWith('update recruitment.application')) {
        const to = String(params[3])
        const expected = Number(params[4])
        return { rows: [{
          current_stage_code: to,
          record_version: expected + 1,
          stage_entered_at_us: CREATED_US + 60_000_000,
        }] }
      }
      if (text.includes('insert into recruitment.event_inbox')) return { rows: [{ event_id: 'evt-test' }] }
      return { rows: [] }
    },
  }
  return client as unknown as DatabaseClient & { readonly calls: Call[] }
}

/** 一行 S6 + 材料 + rubric 齐全的申请（T1 可推进）。 */
function appRow(version = 7): Record<string, unknown> {
  return {
    id: APP_ID,
    current_stage_code: 'S6',
    record_version: version,
    lifecycle_status: 'ACTIVE',
    resume_version_id: '11111111-1111-4111-8111-000000000901',
    rubric_version_id: '11111111-1111-4111-8111-000000000403',
    stage_entered_at_us: CREATED_US,
    created_at_us: CREATED_US,
  }
}

// =====================================================================
//  LOCK-1 / LOCK-2 · stage_advance 域层
// =====================================================================

test('LOCK-1 stage_advance：传旧版本 → VERSION_CONFLICT/STALE_RECORD_VERSION，零写入、零审计', async () => {
  const client = recorder({ app: appRow(7), guardActualVersion: 9 })
  await assert.rejects(
    () => advanceApplicationStage(client, {
      tenantId: TENANT, applicationId: APP_ID, expected_record_version: 7,
    }),
    (error: Error & { message?: string }) => {
      assert.match(error.message ?? '', /^VERSION_CONFLICT:/)
      const detail = JSON.parse((error.message ?? '').slice('VERSION_CONFLICT: '.length)) as Record<string, unknown>
      assert.equal(detail.reason_code, 'STALE_RECORD_VERSION')
      const d = detail.detail as Record<string, unknown>
      assert.equal(d.expected_record_version, 7)
      assert.equal(d.actual_record_version, 9)
      return true
    },
  )
  // 只有守卫的一条 for update；没有任何 UPDATE / insert event_inbox。
  assert.equal(client.calls.length, 1, `冲突后只发 1 条锁读，实发 ${client.calls.length}`)
  assert.match(client.calls[0]?.text ?? '', /for update/)
  assert.equal(client.calls.some((c) => c.text.trimStart().startsWith('update ')), false)
  assert.equal(client.calls.some((c) => c.text.includes('insert into')), false)
})

test('LOCK-1 stage_advance：守卫 SQL 是同事务锁内比较（select … for update），不是"读回来再比"', async () => {
  const client = recorder({ app: appRow(7) })
  await advanceApplicationStage(client, {
    tenantId: TENANT, applicationId: APP_ID, expected_record_version: 7,
  })
  const guard = client.calls[0]
  assert.match(guard?.text ?? '', /^select a\.record_version/)
  assert.match(guard?.text ?? '', /from recruitment\.application a/)
  assert.match(guard?.text ?? '', /where a\.id = \$1 and a\.tenant_id = \$2/)
  assert.match(guard?.text ?? '', /for update/)
  assert.deepEqual(guard?.params, [APP_ID, TENANT])
  // 守卫命中后不得有自赋值 UPDATE（那会让版本 +1）。
  assert.equal(client.calls.some((c) => c.text.includes('set current_stage_code = current_stage_code')), false)
})

test('LOCK-1 stage_advance：传对版本成功推进，守卫本身不令版本 +1（只有一条真实阶段 UPDATE）', async () => {
  const client = recorder({ app: appRow(7) })
  const result = await advanceApplicationStage(client, {
    tenantId: TENANT, applicationId: APP_ID, expected_record_version: 7,
  })
  assert.equal(result.status, 'ADVANCED')
  const writes = client.calls.filter((c) => c.text.trimStart().startsWith('update '))
  assert.equal(writes.length, 1, `只有一条真实阶段 UPDATE，实发 ${writes.length}`)
  assert.equal(writes[0]?.params[4], 7, '第一条真实 UPDATE 的 expected 仍是调用前版本 7')
  assert.equal(result.record_version, 8, '一次推进版本只 +1（7→8），没有幽灵 +1')
})

test('LOCK-2 stage_advance：不传版本 → 零额外查询（没有守卫专用的锁读，第一条就是 diagnose 的申请读）', async () => {
  const client = recorder({ app: appRow(7) })
  await advanceApplicationStage(client, { tenantId: TENANT, applicationId: APP_ID })
  assert.equal(client.calls.length > 0, true)
  // diagnose 本身就有 `select … for update`（既有并发控制），这不是守卫新增的；
  // 守卫专用语句的特征是 `select a.record_version`，不传时必须一条都不发。
  assert.equal(client.calls.some((c) => c.text.trimStart().startsWith('select a.record_version')), false)
  assert.equal(client.calls[0]?.text.includes('stage_entered_at'), true)
  assert.deepEqual(client.calls[0]?.params, [APP_ID, TENANT])
})

test('LOCK-2 stage_advance：NO_OP（已在 S7）传对版本也不写库、版本不变', async () => {
  const noop = appRow(7)
  noop.current_stage_code = 'S7'
  const client = recorder({ app: noop })
  const result = await advanceApplicationStage(client, {
    tenantId: TENANT, applicationId: APP_ID, expected_record_version: 7,
  })
  assert.equal(result.status, 'NO_OP')
  assert.equal(result.record_version, 7, 'NO_OP 版本不变')
  assert.equal(client.calls.some((c) => c.text.trimStart().startsWith('update ')), false)
})

// =====================================================================
//  Schema（D-157：参数必须模型可见）+ 入参校验
// =====================================================================

test('stage_advance schema：expected_record_version 可见、可选、整数；required 不变', () => {
  const tool = createStageAdvanceTool(CFG)
  const parameters = tool.parameters as Record<string, unknown>
  const properties = parameters.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(properties), ['application_id', 'expected_record_version', 'override'])
  assert.deepEqual(parameters.required, ['application_id'])
  assert.equal(parameters.additionalProperties, false)
  const spec = properties.expected_record_version as Record<string, unknown>
  assert.equal(spec.type, 'integer')
  assert.match(String(spec.description), /optimistic/i)
})

test('stage_advance execute：expected 非法值在连库前被拒（整数 ≥1）', async () => {
  const tool = createStageAdvanceTool(CFG)
  for (const bad of [0, -1, 1.5, '1', null]) {
    await assert.rejects(
      () => tool.execute({ application_id: APP_ID, expected_record_version: bad }, undefined),
      (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
      `expected_record_version=${String(bad)} 必须被拒`,
    )
  }
})

test('decision_record schema：顶层 expected_record_version 可见且可选；嵌套 supersedes 未变', () => {
  const tool = createDecisionRecordTool(CFG, {
    resolveSessionActor: (() => { throw new Error('not used in schema test') }) as never,
  } as never)
  const parameters = tool.parameters as Record<string, unknown>
  const properties = parameters.properties as Record<string, unknown>
  assert.equal(properties.expected_record_version !== undefined, true)
  const required = parameters.required as string[]
  assert.equal(required.includes('expected_record_version'), false)
  const supersedes = properties.supersedes as Record<string, unknown>
  assert.deepEqual(supersedes.required, ['decision_id', 'reason', 'expected_record_version'])
})

test('decision_record parse：顶层 expected 非法值 INVALID_ARGS；不传不带键', () => {
  // 一条完整合法入参（抄自 evaluation-decision-record.test.ts 的 baseArgs；只改时间）。
  const base: Record<string, unknown> = {
    application_id: APP_ID,
    decision_scope: 'STAGE',
    interview_id: '11111111-1111-4111-8111-000000000801',
    as_of: '2026-11-13T01:00:00+08:00',
    result: 'HOLD',
    reason: '暂不决定：还差第三位面试官的面评，等补齐再谈',
    basis_refs: [
      {
        kind: 'SUMMARY', summary_digest: 'a'.repeat(64), contract_version: '2.0.0',
        coverage: { required_total: 3, submitted: 2, waived: 0, missing: 1 },
        tally: { advance: 2, hold: 0, reject: 0, waived: 0 }, consensus: 'UNANIMOUS_ADVANCE',
        provenance: 'FIXTURE',
      },
      { kind: 'RUBRIC_VERSION', id: '11111111-1111-4111-8111-000000000403', version_no: 1, payload_hash: 'b'.repeat(64) },
      { kind: 'AUTHORITY', actor_id: ACTOR, is_hiring_manager: false },
    ],
    summary_digest: 'a'.repeat(64),
    human_confirmation: {
      confirmed_by_actor_id: ACTOR,
      confirmed_at: '2026-11-13T01:59:00+08:00',
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: 'd'.repeat(64),
    },
  }
  const now = Date.parse('2026-11-13T02:00:00+08:00')
  const ok = parseDecisionArgs({ ...base, expected_record_version: 3 }, now)
  assert.equal(ok.expected_record_version, 3)
  const absent = parseDecisionArgs({ ...base }, now)
  assert.equal(Object.hasOwn(absent, 'expected_record_version'), false)
  for (const bad of [0, 1.5, '2']) {
    assert.throws(
      () => parseDecisionArgs({ ...base, expected_record_version: bad }, now),
      (error: Error) => /INVALID_ARGS/.test(error.message),
    )
  }
})

// =====================================================================
//  job/close：守卫 SQL 形状 + 冲突零写入（重放分支的锁内比较）
// =====================================================================

test('job/close 路由路径冻结（本轮未新建 job/update 路由）', () => {
  assert.equal(JOB_CLOSE_PATH, '/recruitment/api/job-action/job/close')
})

test('job/close：源码含带版本谓词的同一条 UPDATE（WHERE record_version = $3）', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/http/actions-job.ts'), 'utf8',
  )
  assert.match(src, /const JOB_CLOSE_SQL_EXPECTED = `/)
  const m = src.match(/const JOB_CLOSE_SQL_EXPECTED = `([\s\S]*?)`/)
  assert.ok(m, '找不到 JOB_CLOSE_SQL_EXPECTED')
  assert.match(m?.[1] ?? '', /update recruitment\.job j/)
  assert.match(m?.[1] ?? '', /and j\.record_version = \$3::integer/)
  assert.match(src, /JOB_LOCK_SQL[\s\S]{0,400}for update/)
})

test('job/close：重放路径传旧版本 → 409，零写入零事件', async () => {
  const calls: Call[] = []
  const client = {
    async query(text: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
      calls.push({ text, params })
      if (text.includes('from recruitment.job') && text.includes('for update')) {
        return { rows: [{ id: JOB_ID, status: 'CLOSED', record_version: 4 }] }
      }
      if (text.includes('from recruitment.actor a')) {
        return { rows: [{ actor_id: ACTOR, kind: 'HUMAN', display_name: '测试 HR' }] }
      }
      return { rows: [] }
    },
  } as unknown as DatabaseClient
  await assert.rejects(
    () => closeJobInTransaction(client, CFG, {
      job_id: JOB_ID, actor_id: ACTOR, actor_alias: 'hr',
      expected_record_version: 3,
    }),
    (error: Error & { status?: number; body?: unknown }) => {
      assert.equal(error.status, 409)
      const body = error.body as { error?: Record<string, unknown> }
      assert.equal(body.error?.code, 'VERSION_CONFLICT')
      assert.equal(body.error?.reason_code, 'STALE_RECORD_VERSION')
      const detail = body.error?.detail as Record<string, unknown>
      assert.equal(detail.expected_record_version, 3)
      assert.equal(detail.actual_record_version, 4)
      return true
    },
  )
  assert.equal(calls.some((c) => c.text.trimStart().startsWith('update ')), false)
  assert.equal(calls.some((c) => c.text.includes('insert into')), false)
})
