// candidate_constraint DB 适配器的单测（假 client，不连真库、不 import 产品 index.ts）。
//
// 用 { query: async (sql, params) => ({rows, rowCount}) } 的假 client 验证：
//   * 所有 SQL 带 tenant_id 过滤；
//   * resolveCandidateId 两条路径 + 不一致/不存在；
//   * recordConstraint 的幂等 / INSERT / HANDOFF 链校验分支；
//   * recordUnpin 的墓碑 + supersede 分支与零写入负例；
//   * readPins/readHandoffs 空数组短路 + 排序 SQL；
//   * 错误 reason_code 与顶层 code（INVALID_ARGS / NOT_FOUND）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UNPIN_TOMBSTONE_TEXT,
  readHandoffsForInterviews,
  readPinsForCandidates,
  recordConstraint,
  recordUnpin,
  resolveCandidateId,
  type RecordConstraintParams,
} from '../../src/db/candidate-constraint.ts'
import type { CandidateConstraintRow } from '../../src/domain/candidate-constraint.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const CANDIDATE = '22222222-2222-4222-8222-000000000001'
const OTHER_CANDIDATE = '22222222-2222-4222-8222-000000000002'
const APPLICATION = '33333333-3333-4333-8333-000000000001'
const INTERVIEW = '44444444-4444-4444-8444-000000000001'
const ACTOR = '55555555-5555-4555-8555-000000000001'

interface QueryCall { sql: string; params: unknown[] }
interface QueryResult { rows: unknown[]; rowCount?: number }

/** 按调用顺序返回结果队列的假 client，同时记录每次 SQL。 */
function fakeClient(results: QueryResult[]): { client: { query: (sql: string, params?: unknown[]) => Promise<QueryResult> }; calls: QueryCall[] } {
  const calls: QueryCall[] = []
  let index = 0
  const client = {
    query: async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      const result = results[index]
      index += 1
      if (result === undefined) throw new Error(`unexpected query #${index}: ${sql}`)
      return result
    },
  }
  return { client: client as never, calls }
}

function errorBody(error: unknown): { code?: string; reason_code?: string } {
  assert.ok(error instanceof RecruitmentToolError, `必须是 RecruitmentToolError，实际 ${String(error)}`)
  const code = error.code
  const match = /"reason_code"\s*:\s*"([^"]+)"/.exec(error.message)
  return { code, reason_code: match?.[1] }
}

function ccRow(overrides: Partial<CandidateConstraintRow> & { id: string }): CandidateConstraintRow {
  return {
    tenant_id: TENANT,
    candidate_id: CANDIDATE,
    kind: 'PIN',
    text: '不要加班',
    source: 'CHAT',
    application_id: null,
    interview_id: null,
    created_by_actor_id: ACTOR,
    created_at: '2026-01-01T00:00:00Z',
    superseded_by_constraint_id: null,
    record_version: 1,
    ...overrides,
  }
}

const PIN_PARAMS: RecordConstraintParams = {
  tenant_id: TENANT,
  candidate_id: CANDIDATE,
  kind: 'PIN',
  text: '不要加班',
  source: 'CHAT',
  created_by_actor_id: ACTOR,
}

// ---------------------------------------------------------------------------
//  1. resolveCandidateId
// ---------------------------------------------------------------------------

test('resolveCandidateId：candidate_id 路径校验租户归属，SQL 带 tenant_id', async () => {
  const { client, calls } = fakeClient([{ rows: [{ id: CANDIDATE }] }])
  assert.equal(await resolveCandidateId(client, TENANT, { candidate_id: CANDIDATE }), CANDIDATE)
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /from recruitment\.candidate/)
  assert.match(calls[0].sql, /tenant_id = \$1/)
  assert.deepEqual(calls[0].params, [TENANT, CANDIDATE])
})

test('resolveCandidateId：application_id 路径从 application 反查 candidate_id，SQL 带 tenant_id', async () => {
  const { client, calls } = fakeClient([{ rows: [{ candidate_id: CANDIDATE }] }])
  assert.equal(await resolveCandidateId(client, TENANT, { application_id: APPLICATION }), CANDIDATE)
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /from recruitment\.application/)
  assert.match(calls[0].sql, /tenant_id = \$1/)
  assert.deepEqual(calls[0].params, [TENANT, APPLICATION])
})

test('resolveCandidateId：两者都给且一致 → 返回同一 id', async () => {
  const { client } = fakeClient([{ rows: [{ id: CANDIDATE }] }, { rows: [{ candidate_id: CANDIDATE }] }])
  assert.equal(await resolveCandidateId(client, TENANT, { candidate_id: CANDIDATE, application_id: APPLICATION }), CANDIDATE)
})

test('resolveCandidateId：candidate 越权/不存在 → NOT_FOUND / CANDIDATE_NOT_FOUND', async () => {
  const { client } = fakeClient([{ rows: [] }])
  const error = await resolveCandidateId(client, TENANT, { candidate_id: CANDIDATE }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'NOT_FOUND')
  assert.equal(body.reason_code, 'CANDIDATE_NOT_FOUND')
})

test('resolveCandidateId：application 越权/不存在 → NOT_FOUND / APPLICATION_NOT_FOUND', async () => {
  const { client } = fakeClient([{ rows: [] }])
  const error = await resolveCandidateId(client, TENANT, { application_id: APPLICATION }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'NOT_FOUND')
  assert.equal(body.reason_code, 'APPLICATION_NOT_FOUND')
})

test('resolveCandidateId：两者都给但不一致 → INVALID_ARGS / CANDIDATE_MISMATCH（零写入）', async () => {
  const { client, calls } = fakeClient([{ rows: [{ id: CANDIDATE }] }, { rows: [{ candidate_id: OTHER_CANDIDATE }] }])
  const error = await resolveCandidateId(client, TENANT, { candidate_id: CANDIDATE, application_id: APPLICATION }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, 'CANDIDATE_MISMATCH')
  assert.equal(calls.length, 2, '只做两次 select，无 INSERT/UPDATE')
})

// ---------------------------------------------------------------------------
//  2. recordConstraint —— PIN 分支
// ---------------------------------------------------------------------------

test('recordConstraint PIN 幂等：命中当前行 → inserted=false，零 INSERT', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] }, // resolveCandidateId
    { rows: [ccRow({ id: 'old-id' })] }, // select ... for update
  ])
  const result = await recordConstraint(client, PIN_PARAMS)
  assert.deepEqual(result, { inserted: false, constraint_id: 'old-id', superseded_id: null })
  assert.equal(calls.length, 2)
  assert.equal(calls.some((call) => /\binsert\b/i.test(call.sql)), false)
  assert.ok(calls.slice(1).every((call) => call.params.includes(TENANT)), '后续 SQL 带 tenant_id')
})

test('recordConstraint PIN INSERT：无当前行 → 插新行，不同 text/source 不 supersede 旧 PIN', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] }, // resolve
    { rows: [] }, // 幂等 select
    { rows: [{ id: 'new-id' }] }, // insert
  ])
  const result = await recordConstraint(client, PIN_PARAMS)
  assert.deepEqual(result, { inserted: true, constraint_id: 'new-id', superseded_id: null })
  assert.equal(calls.length, 3)
  assert.match(calls[2].sql, /insert into recruitment\.candidate_constraint/)
  assert.deepEqual(calls[2].params, [TENANT, CANDIDATE, 'PIN', '不要加班', 'CHAT', null, null, ACTOR])
  assert.equal(calls.some((call) => /^update recruitment\.candidate_constraint set/i.test(call.sql)), false)
})

test('recordConstraint PIN 幂等：text/source 不同不命中（防御性：旧行不匹配）→ INSERT', async () => {
  const { client } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [ccRow({ id: 'other-id', text: '另一条', source: 'OTHER' })] },
    { rows: [{ id: 'new-id' }] },
  ])
  const result = await recordConstraint(client, PIN_PARAMS)
  assert.equal(result.inserted, true)
  assert.equal(result.constraint_id, 'new-id')
})

test('recordConstraint：resolve 失败 → NOT_FOUND 且零写入', async () => {
  const { client, calls } = fakeClient([{ rows: [] }])
  const error = await recordConstraint(client, PIN_PARAMS).then(() => null, (e: unknown) => e)
  assert.equal(errorBody(error).code, 'NOT_FOUND')
  assert.equal(calls.length, 1)
})

// ---------------------------------------------------------------------------
//  3. recordConstraint —— HANDOFF 分支
// ---------------------------------------------------------------------------

test('recordConstraint HANDOFF：缺 interview_id → INVALID_ARGS / MISSING_REQUIRED 零写入', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] }, // resolve candidate
    { rows: [{ candidate_id: CANDIDATE }] }, // resolve application（两者一致）
  ])
  const error = await recordConstraint(client, {
    ...PIN_PARAMS, kind: 'HANDOFF', application_id: APPLICATION, interview_id: null,
  }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, 'MISSING_REQUIRED')
  assert.equal(calls.length, 2, '解析后即拒绝，不 INSERT')
})

test('recordConstraint HANDOFF：interview 越权 → NOT_FOUND / INTERVIEW_NOT_FOUND', async () => {
  const { client } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [{ candidate_id: CANDIDATE }] }, // resolve application
    { rows: [] }, // interview select
  ])
  const error = await recordConstraint(client, {
    ...PIN_PARAMS, kind: 'HANDOFF', application_id: APPLICATION, interview_id: INTERVIEW,
  }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'NOT_FOUND')
  assert.equal(body.reason_code, 'INTERVIEW_NOT_FOUND')
})

test('recordConstraint HANDOFF：interview.application_id 与入参不一致 → INVALID_ARGS / INTERVIEW_APPLICATION_MISMATCH', async () => {
  const { client } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [{ candidate_id: CANDIDATE }] }, // resolve application
    { rows: [{ application_id: '99999999-9999-4999-8999-000000000001' }] },
  ])
  const error = await recordConstraint(client, {
    ...PIN_PARAMS, kind: 'HANDOFF', application_id: APPLICATION, interview_id: INTERVIEW,
  }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, 'INTERVIEW_APPLICATION_MISMATCH')
})

test('recordConstraint HANDOFF：没给 application_id 时 interview 反推申请（同候选人）→ INSERT', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] }, // resolve via candidate_id
    { rows: [{ application_id: APPLICATION }] }, // interview 只 select application_id（无 candidate_id 列）
    { rows: [{ candidate_id: CANDIDATE }] }, // application 反查候选人
    { rows: [{ id: 'handoff-id' }] }, // insert
  ])
  const result = await recordConstraint(client, {
    ...PIN_PARAMS, kind: 'HANDOFF', interview_id: INTERVIEW,
  })
  assert.deepEqual(result, { inserted: true, constraint_id: 'handoff-id', superseded_id: null })
  const insert = calls.find((call) => /insert into recruitment\.candidate_constraint/.test(call.sql))
  assert.ok(insert)
  assert.deepEqual(insert.params, [TENANT, CANDIDATE, 'HANDOFF', '不要加班', 'CHAT', APPLICATION, INTERVIEW, ACTOR])
  // interview SQL 不得出现不存在的 candidate_id 列（真库 42703 回归守卫）。
  const interviewQuery = calls.find((call) => /from recruitment\.interview/.test(call.sql))
  assert.ok(interviewQuery)
  assert.equal(interviewQuery.sql.includes('candidate_id'), false)
  assert.match(interviewQuery.sql, /^select application_id from recruitment\.interview/)
  const appQuery = calls.find((call) => /from recruitment\.application/.test(call.sql))
  assert.ok(appQuery)
  assert.match(appQuery.sql, /select candidate_id from recruitment\.application/)
})

test('recordConstraint HANDOFF：interview 反推候选但不一致 → INVALID_ARGS / INTERVIEW_CANDIDATE_MISMATCH', async () => {
  const { client } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [{ application_id: APPLICATION }] },
    { rows: [{ candidate_id: OTHER_CANDIDATE }] }, // application 反查到另一个候选人
  ])
  const error = await recordConstraint(client, {
    ...PIN_PARAMS, kind: 'HANDOFF', interview_id: INTERVIEW,
  }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, 'INTERVIEW_CANDIDATE_MISMATCH')
})

test('recordConstraint HANDOFF：interview 反推申请不存在 → NOT_FOUND / APPLICATION_NOT_FOUND（零写入）', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [{ application_id: APPLICATION }] },
    { rows: [] }, // application 反查无结果
  ])
  const error = await recordConstraint(client, {
    ...PIN_PARAMS, kind: 'HANDOFF', interview_id: INTERVIEW,
  }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'NOT_FOUND')
  assert.equal(body.reason_code, 'APPLICATION_NOT_FOUND')
  assert.equal(calls.some((call) => /^(insert into|update) recruitment\.candidate_constraint/i.test(call.sql)), false)
})

test('recordConstraint HANDOFF（给了 application_id）：interview SQL 不查不存在的 candidate_id 列', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [{ candidate_id: CANDIDATE }] }, // resolve application
    { rows: [{ application_id: APPLICATION }] }, // interview
    { rows: [{ id: 'handoff-id' }] }, // insert
  ])
  await recordConstraint(client, {
    ...PIN_PARAMS, kind: 'HANDOFF', application_id: APPLICATION, interview_id: INTERVIEW,
  })
  const interviewQuery = calls.find((call) => /from recruitment\.interview/.test(call.sql))
  assert.ok(interviewQuery)
  assert.equal(interviewQuery.sql.includes('candidate_id'), false)
  assert.match(interviewQuery.sql, /^select application_id from recruitment\.interview/)
})

test('recordConstraint HANDOFF 完整 INSERT：interview 同链 → 插入含 interview_id', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] }, // resolve candidate
    { rows: [{ candidate_id: CANDIDATE }] }, // resolve application
    { rows: [{ application_id: APPLICATION }] }, // interview
    { rows: [{ id: 'handoff-id' }] }, // insert
  ])
  const result = await recordConstraint(client, {
    ...PIN_PARAMS, kind: 'HANDOFF', application_id: APPLICATION, interview_id: INTERVIEW,
  })
  assert.deepEqual(result, { inserted: true, constraint_id: 'handoff-id', superseded_id: null })
  const insert = calls.find((call) => /insert into recruitment\.candidate_constraint/.test(call.sql))
  assert.ok(insert)
  assert.deepEqual(insert.params, [TENANT, CANDIDATE, 'HANDOFF', '不要加班', 'CHAT', APPLICATION, INTERVIEW, ACTOR])
})

// ---------------------------------------------------------------------------
//  4. recordUnpin —— 墓碑 + supersede
// ---------------------------------------------------------------------------

test('recordUnpin：目标 PIN 存在 → 插墓碑 + 旧行指向墓碑，supersede SQL 带 tenant_id', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] }, // resolve
    { rows: [ccRow({ id: 'target-id' })] }, // select target for update
    { rows: [{ id: 'tombstone-id' }] }, // insert tombstone
    { rowCount: 1, rows: [] }, // supersede update
  ])
  const result = await recordUnpin(client, {
    tenant_id: TENANT, candidate_id: CANDIDATE, text: '不要加班', source: 'CHAT', created_by_actor_id: ACTOR,
  })
  assert.deepEqual(result, { inserted: true, constraint_id: 'tombstone-id', superseded_id: 'target-id' })
  const insert = calls.find((call) => /insert into recruitment\.candidate_constraint/.test(call.sql))
  assert.ok(insert)
  assert.deepEqual(insert.params, [TENANT, CANDIDATE, 'PIN', UNPIN_TOMBSTONE_TEXT, 'CHAT', null, null, ACTOR])
  const update = calls.find((call) => /update recruitment\.candidate_constraint/.test(call.sql))
  assert.ok(update)
  assert.match(update.sql, /set superseded_by_constraint_id = \$2/)
  assert.match(update.sql, /record_version = record_version \+ 1/)
  assert.deepEqual(update.params, [TENANT, 'tombstone-id', 'target-id'])
  assert.equal(calls.length, 4)
})

test('recordUnpin：无 text/source → 选最新一条 PIN（order by created_at desc）', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [ccRow({ id: 'latest-id' })] },
    { rows: [{ id: 'tomb-id' }] },
    { rowCount: 1, rows: [] },
  ])
  const result = await recordUnpin(client, { tenant_id: TENANT, candidate_id: CANDIDATE, created_by_actor_id: ACTOR })
  assert.equal(result.superseded_id, 'latest-id')
  const select = calls[1]
  assert.match(select.sql, /order by created_at desc, id desc/)
  assert.deepEqual(select.params, [TENANT, CANDIDATE])
})

test('recordUnpin：给定 source 但目标无匹配 → NOT_FOUND / PIN_NOT_FOUND 零写入', async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [] },
  ])
  const error = await recordUnpin(client, {
    tenant_id: TENANT, candidate_id: CANDIDATE, text: '不存在', created_by_actor_id: ACTOR,
  }).then(() => null, (e: unknown) => e)
  const body = errorBody(error)
  assert.equal(body.code, 'NOT_FOUND')
  assert.equal(body.reason_code, 'PIN_NOT_FOUND')
  assert.equal(calls.length, 2)
  assert.equal(calls.some((call) => /^(insert into|update) recruitment\.candidate_constraint/i.test(call.sql)), false)
})

test('recordUnpin：supersede 影响行数不为 1 → 抛错（不谎报成功）', async () => {
  const { client } = fakeClient([
    { rows: [{ id: CANDIDATE }] },
    { rows: [ccRow({ id: 'target-id' })] },
    { rows: [{ id: 'tomb-id' }] },
    { rowCount: 0, rows: [] },
  ])
  const error = await recordUnpin(client, { tenant_id: TENANT, candidate_id: CANDIDATE, created_by_actor_id: ACTOR }).then(() => null, (e: unknown) => e)
  assert.ok(error instanceof Error)
  assert.match(error.message, /affected 0 rows/)
})

// ---------------------------------------------------------------------------
//  5. 只读函数
// ---------------------------------------------------------------------------

test('readPinsForCandidates：空数组 → [] 且不发查询', async () => {
  const { client, calls } = fakeClient([])
  assert.deepEqual(await readPinsForCandidates(client, TENANT, []), [])
  assert.equal(calls.length, 0)
})

test('readPinsForCandidates：SQL 带 tenant + kind=PIN + 排序，参数数组按顺序', async () => {
  const rows = [ccRow({ id: 'p1' }), ccRow({ id: 'p2' })]
  const { client, calls } = fakeClient([{ rows }])
  const result = await readPinsForCandidates(client, TENANT, [CANDIDATE, OTHER_CANDIDATE])
  assert.deepEqual(result, rows)
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /tenant_id = \$1/)
  assert.match(calls[0].sql, /candidate_id = any\(\$2::uuid\[\]\)/)
  assert.match(calls[0].sql, /kind = 'PIN'/)
  assert.match(calls[0].sql, /superseded_by_constraint_id is null/)
  assert.match(calls[0].sql, /order by candidate_id, created_at, id/)
  assert.deepEqual(calls[0].params, [TENANT, [CANDIDATE, OTHER_CANDIDATE]])
})

test('readHandoffsForInterviews：空数组 → [] 且不发查询', async () => {
  const { client, calls } = fakeClient([])
  assert.deepEqual(await readHandoffsForInterviews(client, TENANT, []), [])
  assert.equal(calls.length, 0)
})

test('readHandoffsForInterviews：SQL 带 tenant + kind=HANDOFF + 排序', async () => {
  const rows = [ccRow({ id: 'h1', kind: 'HANDOFF', interview_id: INTERVIEW })]
  const { client, calls } = fakeClient([{ rows }])
  const result = await readHandoffsForInterviews(client, TENANT, [INTERVIEW])
  assert.deepEqual(result, rows)
  assert.match(calls[0].sql, /tenant_id = \$1/)
  assert.match(calls[0].sql, /interview_id = any\(\$2::uuid\[\]\)/)
  assert.match(calls[0].sql, /kind = 'HANDOFF'/)
  assert.match(calls[0].sql, /order by interview_id, created_at, id/)
  assert.deepEqual(calls[0].params, [TENANT, [INTERVIEW]])
})
