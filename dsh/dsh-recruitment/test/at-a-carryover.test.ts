// AT-1/2/3 跨岗携带历史的**纯单元测试**（不连库：stub client.query）。
//
// 为什么用 stub 而不是真库：本环境的 RECRUITMENT_DB_PASSWORD 可能不可用，负例必须"现在就能跑"。
// 这里把 `src/db/carry-over.ts` 的每条 SQL 都按 SQL 文本分派，精确断言：
//   * 校验发生在任何 INSERT 之前（负例 insert 调用数 = 0）；
//   * AT-3 唯一键由 `on conflict ... do nothing` 吞掉，返回的 inserted 是真实插入行数；
//   * carried_by_actor_id 用的是调用方传入的写 actor（不来自模型入参）；
//   * 读投影把 source/ref/carried_by 都带出来，空时 count=0 / items=[]。
// 真库端到端证据由 owner lane 的 db/verify.sql + 集成测试补（见最终报告）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  insertCarryOverRefs,
  parseCarryOverRefs,
  validateCarryOverRefs,
  type CarryOverRef,
} from '../src/db/carry-over.ts'
import { createApplicationGetTool, toCarryOverSummary } from '../src/tools/business-read.ts'
import { createApplicationIntakeTool } from '../src/tools/application-intake.ts'
import type { DatabaseClient } from '../src/db/pool.ts'

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TARGET = '00000000-0000-4000-8000-000000000001'
const SOURCE = '00000000-0000-4000-8000-000000000002'
const OTHER_CANDIDATE_SOURCE = '00000000-0000-4000-8000-000000000003'
const SCORECARD = '00000000-0000-4000-8000-000000000011'
const TRANSCRIPT = '00000000-0000-4000-8000-000000000012'
const DECISION = '00000000-0000-4000-8000-000000000013'

interface StubState {
  /** 本租户内可见的申请 id → candidate_id（没在 map 里 = 跨租户或不存在）。 */
  readonly apps: ReadonlyMap<string, string>
  /** ref 是否真的属于该源申请。 */
  readonly belongs: (kind: string, refId: string, sourceId: string) => boolean
}

interface Stubbed {
  readonly client: DatabaseClient
  readonly calls: readonly { readonly sql: string; readonly params: readonly unknown[] }[]
  readonly insertCalls: () => number
  /** 模拟唯一键去重后的真实行数。 */
  readonly storedKeys: () => readonly string[]
}

function stubClient(state: StubState): Stubbed {
  const calls: { sql: string; params: readonly unknown[] }[] = []
  const stored = new Set<string>()
  const refRow = (kind: string, refId: string, sourceId: string) => {
    const ok = state.belongs(kind, refId, sourceId)
    return { rows: ok ? [{ one: 1 }] : [], rowCount: ok ? 1 : 0 }
  }
  const client = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
      calls.push({ sql, params })
      if (sql.includes('from recruitment.application a')) {
        const id = String(params[1])
        const candidate = state.apps.get(id)
        return candidate === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id, candidate_id: candidate }], rowCount: 1 }
      }
      if (sql.includes('from recruitment.scorecard s')) return refRow('SCORECARD', String(params[1]), String(params[2]))
      if (sql.includes('from recruitment.transcript_artifact ta')) return refRow('TRANSCRIPT', String(params[1]), String(params[2]))
      if (sql.includes('from recruitment.decision d')) return refRow('DECISION', String(params[1]), String(params[2]))
      if (sql.includes('insert into recruitment.application_carry_over')) {
        const applicationId = String(params[1])
        const sourceApplicationId = String(params[2])
        const kind = String(params[3])
        const refId = String(params[4])
        const key = [applicationId, sourceApplicationId, kind, refId].join('|')
        if (stored.has(key)) return { rows: [], rowCount: 0 } // on conflict do nothing
        stored.add(key)
        return { rows: [{ id: `carry:${key}` }], rowCount: 1 }
      }
      throw new Error(`stub: unexpected SQL: ${sql.slice(0, 100)}`)
    },
  }
  return {
    client: client as unknown as DatabaseClient,
    calls,
    insertCalls: () => calls.filter((call) => call.sql.includes('insert into recruitment.application_carry_over')).length,
    storedKeys: () => [...stored],
  }
}

/** 从 contractError 的 `<CODE>: <json>` 消息里取 reason_code。 */
function reasonOf(error: unknown): string {
  assert.ok(error instanceof Error, `expected Error, got ${String(error)}`)
  const index = error.message.indexOf(': ')
  const body = JSON.parse(index >= 0 ? error.message.slice(index + 2) : error.message) as Record<string, unknown>
  return String(body.reason_code ?? '')
}

function sameCandidateState(): StubState {
  return {
    apps: new Map([[TARGET, 'candidate-1'], [SOURCE, 'candidate-1']]),
    belongs: (kind, refId, sourceId) => sourceId === SOURCE
      && ((kind === 'SCORECARD' && refId === SCORECARD)
        || (kind === 'TRANSCRIPT' && refId === TRANSCRIPT)
        || (kind === 'DECISION' && refId === DECISION)),
  }
}

function refsTo(source: string): CarryOverRef[] {
  return [
    { source_application_id: source, ref_kind: 'SCORECARD', ref_id: SCORECARD },
    { source_application_id: source, ref_kind: 'TRANSCRIPT', ref_id: TRANSCRIPT },
    { source_application_id: source, ref_kind: 'DECISION', ref_id: DECISION },
  ]
}

// ---------------------------------------------------------------------------
//  形状校验（模型可见参数 + 严格解析）
// ---------------------------------------------------------------------------

test('模型可见参数：carry_over_refs 是对象数组，键闭集；旧键 path/job_id 仍是必填', () => {
  const tool = createApplicationIntakeTool({ converter: {} as never, database: {} as never })
  const parameters = tool.parameters as Record<string, unknown>
  const props = parameters.properties as Record<string, Record<string, unknown>>
  const carry = props.carry_over_refs
  assert.equal(carry.type, 'array')
  assert.deepEqual(parameters.required, ['path', 'job_id'])
  const items = carry.items as Record<string, unknown>
  assert.equal(items.type, 'object')
  assert.equal(items.additionalProperties, false)
  assert.deepEqual(items.required, ['source_application_id', 'ref_kind', 'ref_id'])
  const itemProps = items.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(itemProps.ref_kind.enum, ['SCORECARD', 'TRANSCRIPT', 'DECISION'])
  const serialized = JSON.stringify(parameters)
  assert.ok(!serialized.includes('"tenant_id"'))
  assert.ok(!serialized.includes('"actor_id"'))
})

test('carry_over_refs 未传 ⇒ parse 返回 undefined（旧行为逐字不变）', () => {
  assert.equal(parseCarryOverRefs(undefined), undefined)
})

test('入口接线：execute() 在任何副作用前就严格拒绝非法 carry_over_refs（INVALID_ARGS）', async () => {
  const tool = createApplicationIntakeTool({ converter: {} as never, database: {} as never })
  await assert.rejects(
    tool.execute({ path: '/does/not/matter.pdf', job_id: TARGET, carry_over_refs: [{ bad: 1 }] }, {}),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^INVALID_ARGS:/)
      assert.match(reasonOf(error), /^CARRY_OVER_REF_INVALID$/)
      return true
    },
  )
  // 未知顶层键（含身份键）仍由 parseContractArgs 拒绝，没有被"摘键"绕过。
  await assert.rejects(
    tool.execute({ path: '/x.pdf', job_id: TARGET, actor_id: ACTOR }, {}),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^INVALID_ARGS:/)
      return true
    },
  )
})

test('parseCarryOverRefs：合法数组归一化返回；多键/少键/非对象/非 UUID/越界 kind 全部 INVALID_ARGS', () => {
  const valid = parseCarryOverRefs([{
    source_application_id: SOURCE.toUpperCase(),
    ref_kind: 'SCORECARD',
    ref_id: SCORECARD,
  }])
  assert.deepEqual(valid, [{ source_application_id: SOURCE, ref_kind: 'SCORECARD', ref_id: SCORECARD }])

  const bad: unknown[] = [
    'not-an-array',
    [{ source_application_id: SOURCE }],
    [{ source_application_id: SOURCE, ref_kind: 'SCORECARD', ref_id: SCORECARD, extra: 1 }],
    ['not-an-object'],
    [{ source_application_id: 'not-uuid', ref_kind: 'SCORECARD', ref_id: SCORECARD }],
    [{ source_application_id: SOURCE, ref_kind: 'SCORECARD', ref_id: 'not-uuid' }],
    [{ source_application_id: SOURCE, ref_kind: 'OTHER', ref_id: SCORECARD }],
  ]
  for (const raw of bad) {
    assert.throws(() => parseCarryOverRefs(raw), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^INVALID_ARGS:/)
      assert.match(reasonOf(error), /^CARRY_OVER_(REFS_INVALID|REF_INVALID)$/)
      return true
    }, `应当拒绝：${JSON.stringify(raw)}`)
  }
})

// ---------------------------------------------------------------------------
//  AT-1/2/3 事务内校验（stub client）
// ---------------------------------------------------------------------------

test('AT-1 正向：同候选人的两个申请，三种 ref 全部通过，插入 3 行且 actor 来自调用方', async () => {
  const stub = stubClient(sameCandidateState())
  const refs = refsTo(SOURCE)
  await validateCarryOverRefs(stub.client, TENANT, TARGET, refs)
  const inserted = await insertCarryOverRefs(stub.client, TENANT, TARGET, refs, ACTOR)

  assert.equal(inserted, 3)
  assert.equal(stub.insertCalls(), 3)
  assert.deepEqual(stub.storedKeys().length, 3)
  for (const call of stub.calls.filter((c) => c.sql.includes('insert into recruitment.application_carry_over'))) {
    assert.equal(call.params[5], ACTOR, 'carried_by_actor_id 必须是写 actor')
    assert.match(call.sql, /on conflict \(tenant_id, application_id, source_application_id, ref_kind, ref_id\) do nothing/)
  }
  // 整段没有任何 UPDATE/DELETE：源申请与其它旧行一行不改。
  assert.equal(stub.calls.some((c) => /\b(update|delete)\s+recruitment\./i.test(c.sql)), false)
})

test('AT-2 跨候选人：拒绝，零写入（carry_over INSERT 数 = 0）', async () => {
  const stub = stubClient({
    apps: new Map([[TARGET, 'candidate-1'], [OTHER_CANDIDATE_SOURCE, 'candidate-2']]),
    belongs: () => true,
  })
  await assert.rejects(
    validateCarryOverRefs(stub.client, TENANT, TARGET, refsTo(OTHER_CANDIDATE_SOURCE)),
    (error: unknown) => reasonOf(error) === 'CARRY_OVER_CANDIDATE_MISMATCH',
  )
  assert.equal(stub.insertCalls(), 0, '校验失败必须先抛错，绝不走到 INSERT')
  assert.deepEqual(stub.storedKeys(), [])
})

test('跨租户源申请：租户过滤查不到 ⇒ NOT_FOUND，零写入', async () => {
  const stub = stubClient(sameCandidateState()) // 源 app 不在 apps map（模拟跨租户）
  const crossTenantSource = '00000000-0000-4000-8000-000000000099'
  await assert.rejects(
    validateCarryOverRefs(stub.client, TENANT, TARGET, refsTo(crossTenantSource)),
    (error: unknown) => reasonOf(error) === 'CARRY_OVER_REF_NOT_FOUND',
  )
  assert.equal(stub.insertCalls(), 0)
})

test('源 = 目标：拒绝，零写入', async () => {
  const stub = stubClient(sameCandidateState())
  await assert.rejects(
    validateCarryOverRefs(stub.client, TENANT, TARGET, refsTo(TARGET)),
    (error: unknown) => reasonOf(error) === 'CARRY_OVER_SOURCE_IS_TARGET',
  )
  assert.equal(stub.insertCalls(), 0)
})

test('ref 不属于源申请：拒绝 CARRY_OVER_REF_NOT_FOUND，零写入', async () => {
  const stub = stubClient({
    apps: new Map([[TARGET, 'candidate-1'], [SOURCE, 'candidate-1']]),
    belongs: () => false, // 三种 ref 都查不到归属
  })
  await assert.rejects(
    validateCarryOverRefs(stub.client, TENANT, TARGET, refsTo(SOURCE)),
    (error: unknown) => reasonOf(error) === 'CARRY_OVER_REF_NOT_FOUND',
  )
  assert.equal(stub.insertCalls(), 0)
})

test('AT-3 幂等：同一 ref 提交两次 ⇒ 真实插入恰好 1 行（on conflict do nothing）', async () => {
  const stub = stubClient(sameCandidateState())
  const duplicate: CarryOverRef = { source_application_id: SOURCE, ref_kind: 'SCORECARD', ref_id: SCORECARD }
  await validateCarryOverRefs(stub.client, TENANT, TARGET, [duplicate, duplicate])
  const inserted = await insertCarryOverRefs(stub.client, TENANT, TARGET, [duplicate, duplicate], ACTOR)
  assert.equal(inserted, 1)
  assert.equal(stub.storedKeys().length, 1)
  assert.equal(stub.insertCalls(), 2, '两条语句都发出，第二条被唯一键吞掉')
})

test('AT-1 静态闸门：db 层只 INSERT carry_over，没有 UPDATE/DELETE application', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'src', 'db', 'carry-over.ts'), 'utf8')
  assert.match(src, /insert into recruitment\.application_carry_over/)
  assert.equal(/\bupdate\s+recruitment\.application\b/i.test(src), false)
  assert.equal(/\bdelete\s+from\s+recruitment\./i.test(src), false)
  // 校验必须先于插入（事务内顺序）。
  const intake = readFileSync(join(here, '..', 'src', 'tools', 'application-intake.ts'), 'utf8')
  const v = intake.indexOf('await validateCarryOverRefs(')
  const i = intake.indexOf('await insertCarryOverRefs(')
  assert.ok(v > 0 && i > v, 'validateCarryOverRefs 必须在 insertCarryOverRefs 之前')
})

// ---------------------------------------------------------------------------
//  读投影
// ---------------------------------------------------------------------------

test('读投影：carry_over 块带 source/ref/carried_by，空时 count=0 / items=[]', () => {
  const rows = [{
    application_id: TARGET,
    source_application_id: SOURCE,
    ref_kind: 'SCORECARD',
    ref_id: SCORECARD,
    carried_by_actor_id: ACTOR,
    created_at: new Date('2026-11-19T00:00:00.000Z'),
  }]
  const summary = toCarryOverSummary(rows)
  assert.equal(summary.count, 1)
  assert.deepEqual(summary.items, [{
    source_application_id: SOURCE,
    ref_kind: 'SCORECARD',
    ref_id: SCORECARD,
    carried_by_actor_id: ACTOR,
    created_at: '2026-11-19T00:00:00.000Z',
  }])
  assert.deepEqual(toCarryOverSummary([]), { count: 0, items: [] })
})

test('application_get 读投影接线：一次批量查询 + 按 application_id 分组挂回', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'src', 'tools', 'business-read.ts'), 'utf8')
  assert.match(src, /queryCarryOverRows\(client, cfg, applicationIds\)/)
  assert.match(src, /carryOverByApplication = groupBy\(carryOver/)
  assert.match(src, /carryOverByApplication\.get\(row\.id\) \?\? \[\]/)
  assert.match(src, /carry_over: toCarryOverSummary\(carryOver\)/)
  assert.match(src, /from recruitment\.application_carry_over/)
})

test('application_get 的 output schema：carry_over 恒在（safe required），item 键闭集', () => {
  const tool = createApplicationGetTool({ database: {} as never })
  const root = tool.output.schema as Record<string, unknown>
  const props = root.properties as Record<string, Record<string, unknown>>
  const items = props.applications as Record<string, unknown>
  const appProps = (items.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
  const carry = appProps.carry_over as Record<string, unknown>
  assert.ok((items.items as Record<string, unknown>).required && ((items.items as Record<string, unknown>).required as string[]).includes('carry_over'))
  assert.deepEqual(carry.required, ['count', 'items'])
  const coItems = (carry.properties as Record<string, Record<string, unknown>>).items
  const coItemProps = (coItems.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
  for (const key of ['source_application_id', 'ref_kind', 'ref_id', 'carried_by_actor_id', 'created_at']) {
    assert.equal(coItemProps[key]?.type, 'string', `carry_over item.${key}`)
  }
})
