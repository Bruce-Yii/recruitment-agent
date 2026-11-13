// `recruitment_interview_get` 的入参契约（**不连库**）。
//
// 覆盖 `contracts/interview/tool-contracts.md` §2.1 的四行互斥/依赖表与 §3.7 的
// reason_code 闭集，逐条可机检：
//   * 两个 id 都给 / 都不给 / 只给 round_no / interview_id + round_no
//   * 非 UUID → ID_NOT_UUID；round_no 类型/越界
//   * as_of 未来 → AS_OF_IN_FUTURE；as_of 不带偏移 → AS_OF_FORMAT
//   * require_transcript 类型；未知键 → UNKNOWN_PARAM；tenant_id / actor_id 单独分类
//
// 纪律：本文件**故意**不连库。传进去的 client 一被访问就抛错 —— 参数校验必须发生在
// 碰库之前，正例则必须真的走到查询（这就是"校验没被跳过"的证明）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  INTERVIEW_VALUE_SCHEMA,
  createInterviewGetTool,
  getInTransaction,
  unconfiguredInterviewGetTool,
} from '../../src/tools/interview-get.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const ACTOR = '11111111-1111-4111-8111-000000000103'
const INTERVIEW = '11111111-1111-4111-8111-000000000501'
const APPLICATION = '11111111-1111-4111-8111-000000000601'

/** 服务端"现在"（固定值，测试不读真实时钟）。 */
const NOW_ISO = '2026-11-13T12:00:00+08:00'
const NOW_MS = Date.parse(NOW_ISO)

const CFG: ResolvedDatabaseConfig = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  password: 'not-used-in-unit-tests',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT,
  actor_id: ACTOR,
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000,
  max: 2,
}

const DB_MUST_NOT_BE_TOUCHED = 'validation must not touch the database'

/** 一被访问就抛错的 client：参数层错误必须在它被用到之前抛出。 */
const forbiddenClient = new Proxy({}, {
  get(): never {
    throw new Error(DB_MUST_NOT_BE_TOUCHED)
  },
}) as unknown as DatabaseClient

/** 从契约错误里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
function bodyOf(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof RecruitmentToolError, `期望 RecruitmentToolError，实际 ${String(error)}`)
  assert.ok(error.message.includes(': '), '消息体必须形如 `<CODE>: <json>`')
  const json = error.message.slice(error.message.indexOf(': ') + 2)
  assert.equal(json.includes('\n'), false, '消息体必须单行')
  return JSON.parse(json) as Record<string, unknown>
}

/** 跑一次并取回被抛的错误（不抛也算失败）。 */
async function catchError(rawArgs: unknown, nowMs = NOW_MS): Promise<unknown> {
  let caught: unknown
  try {
    await getInTransaction(forbiddenClient, CFG, rawArgs, nowMs)
  } catch (error) {
    caught = error
  }
  assert.notEqual(caught, undefined, `期望抛错，实际通过了：${JSON.stringify(rawArgs)}`)
  return caught
}

/** 断言一次调用被参数层拒绝，并回传错误体。 */
async function expectInvalid(rawArgs: unknown, reasonCode: string, nowMs = NOW_MS): Promise<Record<string, unknown>> {
  const body = bodyOf(await catchError(rawArgs, nowMs))
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, reasonCode)
  return body
}

/** 把 schema 里所有 `type` 取值收集起来（递归）。 */
function collectTypes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'type') out.push(typeof value === 'string' ? value : JSON.stringify(value))
    collectTypes(value, out)
  }
  return out
}

/** 断言一棵 schema/值里没有 null（DSH 校验器不支持 type 数组，null 会整次 INVALID_TOOL_OUTPUT）。 */
function assertNoNull(node: unknown, path = '$'): void {
  assert.notEqual(node, null, `${path} 不得为 null`)
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoNull(item, `${path}[${index}]`))
    return
  }
  if (typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    assert.notEqual(value, null, `${path}.${key} 不得为 null`)
    assertNoNull(value, `${path}.${key}`)
  }
}

test('两个 id 都给 → INVALID_ARGS(MUTUALLY_EXCLUSIVE)', async () => {
  const body = await expectInvalid({ interview_id: INTERVIEW, application_id: APPLICATION }, 'MUTUALLY_EXCLUSIVE')
  assert.deepEqual(Object.keys(body).sort(), ['code', 'detail', 'message', 'reason_code'])
  assert.deepEqual((body.detail as { given: unknown }).given, {
    interview_id: INTERVIEW, application_id: APPLICATION,
  })
})

test('两个 id 都不给 → INVALID_ARGS(MISSING_REQUIRED)', async () => {
  const body = await expectInvalid({}, 'MISSING_REQUIRED')
  assert.deepEqual((body.detail as { required_one_of: string[] }).required_one_of, ['interview_id', 'application_id'])
})

test('只给 round_no → MISSING_REQUIRED（round_no 依附 application_id）', async () => {
  const body = await expectInvalid({ round_no: 1 }, 'MISSING_REQUIRED')
  assert.deepEqual((body.detail as { given: unknown }).given, { round_no: 1 })
  assert.match(String(body.message), /round_no/)
})

test('interview_id + round_no → MUTUALLY_EXCLUSIVE（单场查询与轮次过滤语义冲突）', async () => {
  const body = await expectInvalid({ interview_id: INTERVIEW, round_no: 2 }, 'MUTUALLY_EXCLUSIVE')
  assert.deepEqual((body.detail as { given: unknown }).given, { interview_id: INTERVIEW, round_no: 2 })
})

test('非 UUID 的 id → ID_NOT_UUID（stub id 也在这里被拒）', async () => {
  const interview = await expectInvalid({ interview_id: 'interview_0001' }, 'ID_NOT_UUID')
  assert.equal((interview.detail as { violations: { path: string; reason_code: string }[] }).violations[0]?.path, 'interview_id')
  await expectInvalid({ application_id: 'app_0001' }, 'ID_NOT_UUID')
})

test('round_no 必须是 1..20 的整数', async () => {
  await expectInvalid({ application_id: APPLICATION, round_no: '1' }, 'TYPE_MISMATCH')
  await expectInvalid({ application_id: APPLICATION, round_no: 1.5 }, 'TYPE_MISMATCH')
  await expectInvalid({ application_id: APPLICATION, round_no: 0 }, 'OUT_OF_RANGE')
  await expectInvalid({ application_id: APPLICATION, round_no: 21 }, 'OUT_OF_RANGE')
})

test('require_transcript 必须是布尔（"true" 不通过）', async () => {
  await expectInvalid({ interview_id: INTERVIEW, require_transcript: 'true' }, 'TYPE_MISMATCH')
  await expectInvalid({ interview_id: INTERVIEW, require_transcript: 1 }, 'TYPE_MISMATCH')
})

test('as_of 晚于服务端 now → AS_OF_IN_FUTURE', async () => {
  const body = await expectInvalid(
    { interview_id: INTERVIEW, as_of: '2026-11-14T00:00:00+08:00' },
    'AS_OF_IN_FUTURE',
  )
  assert.equal((body.detail as { as_of: string }).as_of, '2026-11-14T00:00:00+08:00')
})

test('as_of 不带偏移 / 不是时间 → AS_OF_FORMAT', async () => {
  await expectInvalid({ interview_id: INTERVIEW, as_of: '2026-11-13T00:00:00' }, 'AS_OF_FORMAT')
  await expectInvalid({ interview_id: INTERVIEW, as_of: 'yesterday' }, 'AS_OF_FORMAT')
})

test('未知键 → UNKNOWN_PARAM（force / allow_conflict / status / record_version 都不是本工具的入参）', async () => {
  for (const key of ['force', 'allow_conflict', 'skip_conflict_check', 'status', 'record_version']) {
    const body = await expectInvalid({ interview_id: INTERVIEW, [key]: true }, 'UNKNOWN_PARAM')
    const violations = (body.detail as { violations: { path: string; reason_code: string }[] }).violations
    assert.equal(violations[0]?.path, key)
    assert.equal(violations[0]?.reason_code, 'UNKNOWN_PARAM')
  }
})

test('tenant_id / actor_id → TENANT_OR_ACTOR_NOT_ALLOWED（不是静默忽略）', async () => {
  for (const key of ['tenant_id', 'actor_id']) {
    const body = await expectInvalid({ interview_id: INTERVIEW, [key]: TENANT }, 'TENANT_OR_ACTOR_NOT_ALLOWED')
    assert.equal((body.detail as { violations: { path: string }[] }).violations[0]?.path, key)
  }
})

test('arguments 不是 JSON 对象 → TYPE_MISMATCH', async () => {
  await expectInvalid([], 'TYPE_MISMATCH')
  await expectInvalid('interview_id=x', 'TYPE_MISMATCH')
})

test('正例：合法入参通过校验后才碰库（BY_INTERVIEW / BY_APPLICATION+round_no 两条路径）', async () => {
  for (const args of [
    { interview_id: INTERVIEW, as_of: '2026-11-13T00:00:00+08:00' },
    { application_id: APPLICATION, round_no: 2, require_transcript: false },
  ]) {
    let caught: unknown
    try {
      await getInTransaction(forbiddenClient, CFG, args, NOW_MS)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof Error, `期望走到查询，实际没有报错：${JSON.stringify(args)}`)
    assert.equal(caught.message, DB_MUST_NOT_BE_TOUCHED, `参数层不应拒绝：${JSON.stringify(args)}`)
  }
})

test('未配置替身：调用报 NOT_CONFIGURED 并列出缺什么', async () => {
  const tool = unconfiguredInterviewGetTool(['config.database.host is required', 'environment variable X is not set'])
  assert.equal(tool.name, 'recruitment_interview_get')
  assert.equal((tool.parameters as { additionalProperties: boolean }).additionalProperties, false)
  let caught: unknown
  try {
    await tool.execute({ interview_id: INTERVIEW }, undefined)
  } catch (error) {
    caught = error
  }
  const body = bodyOf(caught)
  assert.equal(body.code, 'NOT_CONFIGURED')
  assert.equal(body.reason_code, 'PLUGIN_NOT_CONFIGURED')
  assert.deepEqual((body.detail as { issues: string[] }).issues, [
    'config.database.host is required', 'environment variable X is not set',
  ])
})

test('工具面：参数 schema 拒绝未知键，输出 schema 只用 DSH 子集且值里没有 null 分支', () => {
  const tool = createInterviewGetTool(CFG)
  assert.equal(tool.name, 'recruitment_interview_get')
  const parameters = tool.parameters as { type: string; additionalProperties: boolean; properties: Record<string, unknown>; required: string[] }
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(parameters.properties).sort(), [
    'application_id', 'as_of', 'interview_id', 'require_transcript', 'round_no',
  ])
  // 五个参数都靠运行时校验（互斥/依赖不是 JSON Schema 子集能表达的），所以 required 为空。
  assert.deepEqual(parameters.required, [])

  const outputSchema = tool.output.schema as Record<string, unknown>
  for (const node of [outputSchema, INTERVIEW_VALUE_SCHEMA]) {
    const types = collectTypes(node)
    assert.ok(types.length > 0)
    for (const type of types) {
      assert.ok(
        ['string', 'integer', 'boolean', 'object', 'array'].includes(type),
        `type=${type} 不在 DSH 强制子集里（不得有 type:'null' 或 type 数组）`,
      )
    }
    assertNoNull(node)
  }

  // `interviews[]` 元素的必需键（少一个就意味着 A 侧拿不到形状保证）。
  const required = (INTERVIEW_VALUE_SCHEMA as { required: string[] }).required
  for (const key of [
    'id', 'application_id', 'candidate_id', 'job_id', 'round_no', 'slot_code', 'stage_code', 'status',
    'record_version', 'timezone', 'status_changed_at', 'is_overdue_start', 'interviewers',
    'meeting_binding', 'transcript', 'evaluation', 'warnings',
  ]) {
    assert.ok(required.includes(key), `interviews[] 元素缺少必需键 ${key}`)
  }
  assert.equal((INTERVIEW_VALUE_SCHEMA as { additionalProperties: boolean }).additionalProperties, false)
})
