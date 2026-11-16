// 追溯接线真库集成测试（task：tool_call 真行 / trace_get 环已补 / 负例 / 幂等）。
//
// 目标 bug：`src/domain/trace.ts` 的 `recordToolCall` / `runTracedToolCall` 实现完整，
// 但**工具执行路径从未调用** → 生产库 `recruitment.tool_call` 0 行，
// `recruitment_trace_get` 永远报 `TOOL_CALL` 环缺失（gap）。
//
// 本文件证明四件事（全部用**一次性库**；真提交、跨连接可见；结束删库）：
//   1. 成功调用一次真实注册表里的工具（`recruitment_application_get`，经 `withToolCallTrace`
//      包装）后，`recruitment.tool_call` 真的有行：tool_name / call_ref / outcome /
//      business_refs / correlation_id / args_digest / result_digest 全部是真值；
//      且 `actor_id` = 执行时从 `exec.agent.id` 解析出的 recruiter（…0103），
//      **不是** apply 配置里的默认 actor（interviewer_b …0105）——
//      证明"按执行时的执行者记账"，不是照抄配置。
//   2. `recruitment_trace_get(APPLICATION, app)` 的返回里 `counts.TOOL_CALL >= 1`、
//      `rings` 有 `TOOL_CALL`、`integrity.gaps` **不再**含 `TOOL_CALL`（环已补）。
//   3. 负例：包装后的工具遇到非法参数，抛出的错误与**未包装**的同一个工具逐字相同
//      （name / code / message）；同时库里落 `outcome='FAILED'` + `error_code='INVALID_ARGS'`。
//   4. 幂等：同一个 `exec.callId` 连续调用两次都成功，`call_ref` 行数 = 1（重放不重复记）。
//
// 接线方式说明（如实证）：`apply()` 已经把工具做了 `map(withStructuredResultContract)`；
// 本测试在**拿到注册表之后**再 `.map(withToolCallTrace({database, identity}))`——
// 这与总控将落到 `src/index.ts` 注册点的 patch 等价（patch 未落地前用这个方式取证）。
// 一次性库由 `./db.ts` 的 `createIsolatedTestDatabase('trace_wire')` 建并重放 0001→0016。
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, __testHooks } from '../../src/index.ts'
import { withToolCallTrace } from '../../src/tools/traced.ts'
import type { ReadonlyToolDefinition } from '../../src/tools/definition.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  TENANT,
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  testDatabaseConfig,
} from './db.ts'

/** 0002_seed 的演示岗位（对 fixture application 来说是真实的岗位/版本外键）。 */
const DEMO_JOB = '11111111-1111-4111-8111-000000000401'
/** Demo Actor 映射（app.ts 默认）：recruiter / interviewer_b（见 demo-actor 契约）。 */
const ACTOR_RECRUITER = '11111111-1111-4111-8111-000000000103'
const ACTOR_INTERVIEWER_B = '11111111-1111-4111-8111-000000000105'
/** DSH session（`exec.agent.id` 的规范形态：`session-<uuid>`）。 */
const SESSION_ID = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** 一次调用 → `{ callId, agent }`；callId 决定 call_ref 与幂等。 */
function execOf(callId: string): { callId: string; agent: { id: string } } {
  return { callId, agent: { id: SESSION_ID } }
}

/** 捕获一次调用的结局（负例比较错误原文用；不吞断言）。 */
async function captureError(fn: () => Promise<unknown>): Promise<{
  name: string
  code: string | undefined
  message: string
}> {
  try {
    await fn()
  } catch (error) {
    const record = error as { name?: unknown; code?: unknown; message?: unknown }
    return {
      name: typeof record.name === 'string' ? record.name : 'unknown',
      code: typeof record.code === 'string' ? record.code : undefined,
      message: typeof record.message === 'string' ? record.message : String(error),
    }
  }
  throw new Error('预期这次调用抛错，但它成功了')
}

/** 该申请的 fixture：candidate + application（application 的 correlation 由 0013 触发器盖章）。 */
interface Fixture {
  readonly candidateId: string
  readonly applicationId: string
  readonly correlationId: string
}

/**
 * 在一次性库里造最小真实夹具：candidate → application（用演示岗位 + 其 job_version）。
 *
 * 为什么必须 insert 而不借 0002_seed 的 `…0701`：那是 0013 迁移**之前**的行，
 * `correlation_id` 为 NULL，不能拿来做"链已串起来"的证据。新插入的 application 会由
 * `trg_application_trace` 盖上一枚**真实** correlation（不是手工伪造）。
 */
async function insertFixture(pool: import('pg').Pool): Promise<Fixture> {
  const client = await pool.connect()
  try {
    const jobVersion = await client.query<{ id: string }>(
      'select current_job_version_id as id from recruitment.job where id = $1 and tenant_id = $2',
      [DEMO_JOB, TENANT],
    )
    const jobVersionId = jobVersion.rows[0]?.id
    if (typeof jobVersionId !== 'string') throw new Error('演示岗位没有 current_job_version_id，无法造申请夹具')

    const candidate = await client.query<{ id: string }>(
      `insert into recruitment.candidate
         (tenant_id, display_name, normalized_email, normalized_phone, identity_status)
       values ($1, 'trace-wiring fixture', 'trace-wiring-fixture@example.invalid', '+8610000000001', 'ACTIVE')
       returning id`,
      [TENANT],
    )
    const candidateId = candidate.rows[0]?.id
    if (candidateId === undefined) throw new Error('fixture candidate insert 没有返回 id')

    // **不写 correlation_id 列**：让迁移 0013 的 trg_application_trace 盖章（真实链路）。
    const application = await client.query<{ id: string; correlation_id: string | null }>(
      `insert into recruitment.application
         (tenant_id, candidate_id, job_id, job_version_id, current_stage_code, lifecycle_status)
       values ($1, $2, $3, $4, 'S7', 'ACTIVE')
       returning id, correlation_id`,
      [TENANT, candidateId, DEMO_JOB, jobVersionId],
    )
    const row = application.rows[0]
    if (row === undefined) throw new Error('fixture application insert 没有返回行')
    assert.match(row.correlation_id ?? '', /^[0-9a-f-]{36}$/, '0013 触发器必须给新申请盖上 correlation_id')
    return { candidateId, applicationId: row.id, correlationId: row.correlation_id as string }
  } finally {
    client.release()
  }
}

/** 读一行 tool_call（只取本测试要断言的列）。 */
interface ToolCallRow {
  readonly id: string
  readonly tool_name: string
  readonly call_ref: string
  readonly outcome: string
  readonly error_code: string | null
  readonly actor_id: string | null
  readonly correlation_id: string
  readonly business_refs: unknown
  readonly args_digest: string | null
  readonly result_digest: string | null
  readonly started_at: Date
  readonly ended_at: Date | null
  readonly duration_ms: string | number | null
}

async function readToolCall(pool: import('pg').Pool, callRef: string): Promise<ToolCallRow | undefined> {
  const { rows } = await pool.query<ToolCallRow>(
    `select id, tool_name, call_ref, outcome, error_code, actor_id, correlation_id,
            business_refs, args_digest, result_digest, started_at, ended_at, duration_ms
       from recruitment.tool_call
      where tenant_id = $1 and call_ref = $2`,
    [TENANT, callRef],
  )
  return rows[0]
}

/** 申请 id 是否出现在 application_get 的返回值里（单条查询返回 applications 数组）。 */
function applicationIdsIn(value: unknown): string[] {
  const record = value as Record<string, unknown> | null
  const applications = Array.isArray(record?.applications) ? record.applications : []
  const ids: string[] = []
  for (const item of applications) {
    const id = (item as Record<string, unknown> | null)?.application_id
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

test('trace wiring：真库 tool_call 真行 + trace_get 环已补 + 负例原样 + 幂等', async () => {
  const db = await createIsolatedTestDatabase('trace_wire')
  assertPrivateDatabase(db.name)
  try {
    // ------------------------------------------------------------------
    //  0. 装配：apply() 假 ctx → 注册表 → withToolCallTrace（等价注册点 patch）
    // ------------------------------------------------------------------
    const base = testDatabaseConfig()
    // 工具/记录适配器都指向**一次性库**；actor_id 故意设成 interviewer_b（…0105），
    // 以便与"执行时解析出的 recruiter（…0103）"区分开。
    const dbCfg: ResolvedDatabaseConfig = { ...base, database: db.name, actor_id: ACTOR_INTERVIEWER_B }
    const env: Record<string, string> = { [base.password_env]: base.password }

    const registered: ReadonlyToolDefinition[] = []
    const ctx = {
      tools: { register: (tool: ReadonlyToolDefinition) => { registered.push(tool) } },
      effect: (fn: () => unknown) => fn(),
      inject: (_names: readonly string[], _cb: (child: unknown) => void) => {},
    }
    apply(ctx as never, {
      database: {
        host: base.host,
        port: base.port,
        user: base.user,
        database: db.name,
        tenant_id: TENANT,
        actor_id: ACTOR_INTERVIEWER_B,
      },
    }, env)

    const names = registered.map((tool) => tool.name)
    assert.ok(names.includes('recruitment_application_get'), `注册表少了 application_get：${names.join(', ')}`)
    assert.ok(names.includes('recruitment_trace_get'), `注册表少了 trace_get：${names.join(', ')}`)

    const identity = __testHooks.demoActorIdentity
    assert.ok(identity !== null, 'apply() 必须装配 Demo Actor 身份（单例）')
    // 执行时解析：当前 session 绑定 recruiter（与配置默认 actor …0105 不同）。
    identity.registry.bind(SESSION_ID, 'recruiter', { display_name: 'trace wiring recruiter' })

    // 与总控将落到 src/index.ts 的 patch 等价：注册表再套一层 trace mapper。
    const traced: readonly ReadonlyToolDefinition[] = registered.map(
      withToolCallTrace({ database: dbCfg, identity }),
    )
    const appGet = traced.find((tool) => tool.name === 'recruitment_application_get')
    const traceGet = traced.find((tool) => tool.name === 'recruitment_trace_get')
    if (appGet === undefined || traceGet === undefined) throw new Error('traced 注册表缺工具')

    // 基线：包装之前库里 0 行（证明下面的行确实是这次真实调用写进来的）。
    const baseline = await db.pool.query<{ n: number }>('select count(*)::int as n from recruitment.tool_call')
    assert.equal(baseline.rows[0]?.n, 0, '一次性库的 tool_call 基线必须是 0 行')

    const fixture = await insertFixture(db.pool)

    // ------------------------------------------------------------------
    //  1. 成功调用 → tool_call 真行
    // ------------------------------------------------------------------
    const callId = 'call-trace-wiring-it-1'
    const callRef = `recruitment_application_get:${callId}`
    const appValue = await appGet.execute({ application_id: fixture.applicationId }, execOf(callId))
    assert.deepEqual(applicationIdsIn(appValue), [fixture.applicationId], '工具必须读回这条申请')

    const row = await readToolCall(db.pool, callRef)
    assert.ok(row !== undefined, `成功调用后必须存在 tool_call 行：${callRef}`)
    assert.equal(row.tool_name, 'recruitment_application_get')
    assert.equal(row.call_ref, callRef)
    assert.equal(row.outcome, 'SUCCEEDED')
    assert.equal(row.error_code, null)
    // 业务引用必须是工具**自己返回**的申请（不是猜的、不是 session id）。
    assert.ok(Array.isArray(row.business_refs), 'business_refs 必须是数组')
    assert.deepEqual(
      (row.business_refs as { kind?: unknown; id?: unknown }[]).some(
        (ref) => ref.kind === 'APPLICATION' && ref.id === fixture.applicationId,
      ),
      true,
      `business_refs 必须含 {kind:'APPLICATION', id:${fixture.applicationId}}，实际：${JSON.stringify(row.business_refs)}`,
    )
    // R7：只落摘要，不落正文；摘要必须是 64 位 hex（与迁移 ck_tool_call_digests 一致）。
    assert.match(row.args_digest ?? '', /^[0-9a-f]{64}$/, 'args_digest 必须是 64hex')
    assert.match(row.result_digest ?? '', /^[0-9a-f]{64}$/, 'result_digest 必须是 64hex')
    // 执行者来自 exec（session→recruiter …0103），不是配置默认（interviewer_b …0105）。
    assert.equal(row.actor_id, ACTOR_RECRUITER, 'actor_id 必须按 exec 解析（recruiter …0103），不是配置默认 …0105')
    assert.notEqual(row.actor_id, ACTOR_INTERVIEWER_B)
    // 链：申请的 correlation（由触发器盖章）被继承，而不是新开一条。
    assert.equal(row.correlation_id, fixture.correlationId, 'tool_call 必须继承申请的 correlation_id')
    assert.ok(row.ended_at instanceof Date, '终态行必须有 ended_at')
    assert.ok(Number(row.duration_ms) >= 0, 'duration_ms 必须是 >= 0 的毫秒数')

    // ------------------------------------------------------------------
    //  2. trace_get：TOOL_CALL 环已补
    // ------------------------------------------------------------------
    const traceValue = (await traceGet.execute(
      { object_type: 'APPLICATION', object_id: fixture.applicationId },
      execOf('call-trace-wiring-it-2'),
    )) as {
      correlation_id?: string
      counts: Record<string, number>
      rings: { ring: string; on_chain: boolean; state?: string; refs?: Record<string, unknown> }[]
      integrity: { gaps: { ring: string }[]; breakpoints: { code: string }[] }
    }
    assert.equal(traceValue.correlation_id, fixture.correlationId)
    assert.ok((traceValue.counts.TOOL_CALL ?? 0) >= 1, `counts.TOOL_CALL 必须 >= 1，实际 ${traceValue.counts.TOOL_CALL}`)
    const toolRing = traceValue.rings.find((ring) => ring.ring === 'TOOL_CALL' && ring.on_chain === true)
    assert.ok(toolRing !== undefined, 'rings 必须有一条 on_chain 的 TOOL_CALL 环')
    assert.equal(toolRing.refs?.tool_name, 'recruitment_application_get')
    assert.equal(toolRing.refs?.call_ref, callRef)
    assert.equal(toolRing.state, 'SUCCEEDED')
    assert.equal(
      traceValue.integrity.gaps.some((gap) => gap.ring === 'TOOL_CALL'),
      false,
      `integrity.gaps 里不许再有 TOOL_CALL，实际 gaps：${traceValue.integrity.gaps.map((gap) => gap.ring).join(',')}`,
    )

    // ------------------------------------------------------------------
    //  3. 负例：错误原文与未包装工具逐字相同；库里落 FAILED + error_code
    // ------------------------------------------------------------------
    // 未包装 = apply() 注册表原样（不经过 trace mapper）。
    const unwrapped = registered.find((tool) => tool.name === 'recruitment_application_get')
    if (unwrapped === undefined) throw new Error('注册表缺未包装的 application_get')
    const invalidArgs = { application_id: 'not-a-uuid' }
    const plain = await captureError(() => unwrapped.execute(invalidArgs, {}))
    const negativeCallId = 'call-trace-wiring-it-neg'
    const negCallRef = `recruitment_application_get:${negativeCallId}`
    const tracedError = await captureError(() => appGet.execute(invalidArgs, execOf(negativeCallId)))
    assert.deepEqual(
      tracedError,
      plain,
      `包装前后错误必须逐字相同：plain=${JSON.stringify(plain)} traced=${JSON.stringify(tracedError)}`,
    )
    assert.equal(tracedError.code, 'INVALID_ARGS')
    assert.equal(tracedError.name, 'RecruitmentToolError')

    const failedRow = await readToolCall(db.pool, negCallRef)
    assert.ok(failedRow !== undefined, `负例调用必须落一行：${negCallRef}`)
    assert.equal(failedRow.outcome, 'FAILED')
    assert.equal(failedRow.error_code, 'INVALID_ARGS')
    assert.equal(failedRow.tool_name, 'recruitment_application_get')
    assert.equal(failedRow.result_digest, null, '失败调用没有结果摘要（不伪造）')

    // ------------------------------------------------------------------
    //  4. 幂等：同一 exec.callId 连调两次 → call_ref 行数 = 1
    // ------------------------------------------------------------------
    const replayCallId = 'call-trace-wiring-it-idem'
    const replayCallRef = `recruitment_application_get:${replayCallId}`
    const replayExec = execOf(replayCallId)
    const first = await appGet.execute({ application_id: fixture.applicationId }, replayExec)
    const second = await appGet.execute({ application_id: fixture.applicationId }, replayExec)
    assert.deepEqual(applicationIdsIn(first), [fixture.applicationId], '第一次重放必须正常返回')
    assert.deepEqual(applicationIdsIn(second), [fixture.applicationId], '第二次（同 callId）必须正常返回')
    const replayCount = await db.pool.query<{ n: number }>(
      "select count(*)::int as n from recruitment.tool_call where tenant_id = $1 and call_ref = $2",
      [TENANT, replayCallRef],
    )
    assert.equal(replayCount.rows[0]?.n, 1, `同一 call_ref 必须只有 1 行：${replayCallRef}`)

    // 该申请链上的成功行 = 首次 + 重放（同一行） = 2；FAILED 行因为无业务引用落在新链上。
    const chainRows = await db.pool.query<{ n: number }>(
      "select count(*)::int as n from recruitment.tool_call where tenant_id = $1 and correlation_id = $2 and outcome = 'SUCCEEDED'",
      [TENANT, fixture.correlationId],
    )
    assert.equal(chainRows.rows[0]?.n, 2, '申请链上应有 2 条成功调用（首调 + 幂等重放）')
  } finally {
    await db.drop()
  }
})
