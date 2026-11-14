// R4 三维标签的**机检**（N10 / `docs/23` P2-03 的回归）——不连库。
//
// 这个文件回答三个问题，全部可机检：
//   1. `provenance` 的判定式有没有被写死？—— 用假 client 跑判定表的**每一行**：
//      只有"租户被显式声明为非合成"才是 LIVE；缺租户行 / 有合成标记 / 缺声明一律 FIXTURE（fail-closed）。
//   2. 三个工具的 `output.schema.labels` 三轴齐不齐、枚举有没有被放宽？
//      三个写/读工具的 `connection` 只允许 NOT_CONNECTED（这些工具不接任何外部系统），
//      `provenance` 只允许 LIVE|FIXTURE（不许出现第四种取值）。
//   3. 源码里还有没有硬编码的出口标签？—— 三个工具源文件里 `provenance: 'LIVE'` 必须 0 命中，
//      且三处都必须 import 同一个判定实现（防止三个文件各写一份慢慢漂移）。
//
// 背景：`interview_schedule` / `job_create` 曾写死 `provenance: 'LIVE'`，而 `ra_s6s7` 是
// 0002_seed 的"演示租户 + 合成数据"（`organization.name` = '演示租户 · DEMO ONLY（非真实数据）'）。
// 把合成数据标成 LIVE 会把"演示通过"污染成"真实能力"，是 R4 的原始事故。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  buildThreeAxisLabels,
  createCandidateGetTool,
  resolveTenantProvenance,
} from '../../src/tools/candidate-get.ts'
import { createInterviewScheduleTool } from '../../src/tools/interview-schedule.ts'
import { createJobCreateTool, createJobUpdateTool } from '../../src/tools/job-create.ts'

/** 本文件不连库：配置只在造工具定义（读 schema）时用到，执行路径不会被调用。 */
const CFG = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  password: 'unused-in-this-test',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000,
  max: 2,
} as ResolvedDatabaseConfig

/** 三处工具源文件（相对本测试文件）。 */
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools')

/**
 * 假连接：返回固定的一行（模拟 `resolveTenantProvenance` 的租户事实查询）。
 * @param row - 查询结果的第一行（`undefined` = 0 行）。
 * @returns 可以当作 `DatabaseClient` 用的对象，并记录本次 SQL 文本与参数。
 */
function fakeClient(row?: Record<string, unknown>): DatabaseClient & {
  readonly calls: { text: string; params: readonly unknown[] }[]
} {
  const calls: { text: string; params: readonly unknown[] }[] = []
  const client = {
    calls,
    async query(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params })
      return { rows: row === undefined ? [] : [row] }
    },
  }
  return client as unknown as DatabaseClient & { readonly calls: { text: string; params: readonly unknown[] }[] }
}

/** 从工具定义里取 labels 的 schema。 */
function labelsSchema(tool: { output: { schema: unknown } }): Record<string, unknown> {
  const schema = tool.output.schema as Record<string, unknown>
  const properties = schema.properties as Record<string, unknown>
  const labels = properties.labels as Record<string, unknown> | undefined
  assert.ok(labels !== undefined, 'output.schema 必须声明 labels（三维标签不能缺席）')
  return labels
}

/** 取某个标签维度的 enum。 */
function labelEnum(labels: Record<string, unknown>, axis: string): string[] {
  const properties = labels.properties as Record<string, Record<string, unknown>>
  const property = properties[axis]
  assert.ok(property !== undefined, `labels.${axis} 必须存在`)
  assert.equal(property.type, 'string', `labels.${axis} 必须是单类型 string（DSH 子集不许类型数组）`)
  assert.ok(Array.isArray(property.enum), `labels.${axis} 必须是封闭枚举`)
  return property.enum as string[]
}

// ---------------------------------------------------------------------------
//  1. 判定式：只有正面证据才是 LIVE
// ---------------------------------------------------------------------------

test('provenance 判定式：演示租户（有 demo 标记）⇒ FIXTURE，即使别处写了 synthetic=false', async () => {
  const client = fakeClient({ tenant_exists: true, demo: 'true', synthetic: 'false' })
  assert.equal(await resolveTenantProvenance(client, CFG.tenant_id), 'FIXTURE')
})

test('provenance 判定式：缺租户行 / 缺声明 ⇒ FIXTURE（fail-closed，没有证据不许自称 LIVE）', async () => {
  assert.equal(await resolveTenantProvenance(fakeClient(undefined), CFG.tenant_id), 'FIXTURE')
  assert.equal(
    await resolveTenantProvenance(fakeClient({ tenant_exists: false, demo: null, synthetic: null }), CFG.tenant_id),
    'FIXTURE',
  )
  assert.equal(
    await resolveTenantProvenance(fakeClient({ tenant_exists: true, demo: null, synthetic: null }), CFG.tenant_id),
    'FIXTURE',
  )
  assert.equal(
    await resolveTenantProvenance(fakeClient({ tenant_exists: true, demo: null, synthetic: 'true' }), CFG.tenant_id),
    'FIXTURE',
  )
})

test('provenance 判定式：只有"显式声明非合成 + 无合成标记"才是 LIVE', async () => {
  const client = fakeClient({ tenant_exists: true, demo: null, synthetic: 'false' })
  assert.equal(await resolveTenantProvenance(client, CFG.tenant_id), 'LIVE')
  // 判定读的是库里的租户事实：一次查询、参数只有 tenant_id + 两个配置键，没有写死的租户白名单。
  assert.equal(client.calls.length, 1)
  const call = client.calls[0]
  assert.ok(call !== undefined)
  assert.match(call.text, /recruitment\.business_config/)
  assert.match(call.text, /recruitment\.organization/)
  assert.match(call.text, /distinct on \(config_key\)/, '同键多版本时必须取最新一版')
  assert.deepEqual(call.params, [CFG.tenant_id, 'stage_catalog', 'tenant_provenance'])
})

test('三维标签：trigger 恒 MANUAL、connection 恒 NOT_CONNECTED（与 provenance 正交，不压成一维）', async () => {
  const fixture = await buildThreeAxisLabels(
    fakeClient({ tenant_exists: true, demo: 'true', synthetic: null }),
    CFG.tenant_id,
  )
  assert.deepEqual(fixture, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })

  const live = await buildThreeAxisLabels(
    fakeClient({ tenant_exists: true, demo: null, synthetic: 'false' }),
    CFG.tenant_id,
  )
  // 其余两轴不变：数据真 != 自动触发，也 != 能读外部系统。
  assert.deepEqual(live, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
})

// ---------------------------------------------------------------------------
//  2. 三个工具的出口 schema：三轴齐、枚举不放宽
// ---------------------------------------------------------------------------

test('output.schema.labels：job_create / job_update / interview_schedule / candidate_get 都三轴齐全', () => {
  const tools = {
    recruitment_job_create: createJobCreateTool(CFG),
    recruitment_job_update: createJobUpdateTool(CFG),
    recruitment_interview_schedule: createInterviewScheduleTool(CFG),
    recruitment_candidate_get: createCandidateGetTool(CFG),
  }
  for (const [name, tool] of Object.entries(tools)) {
    const schema = tool.output.schema as Record<string, unknown>
    const required = schema.required as string[]
    const labels = labelsSchema(tool)
    assert.deepEqual(
      labels.required,
      ['provenance', 'trigger', 'connection'],
      `${name}: labels 必须三轴全 required`,
    )
    assert.ok(required.includes('labels'), `${name}: labels 必须在顶层 required 里`)
    // 封闭枚举、单类型；不许出现第四种取值。
    assert.deepEqual(labelEnum(labels, 'provenance').sort(), ['FIXTURE', 'LIVE'])
    assert.deepEqual(labelEnum(labels, 'trigger'), ['MANUAL'])
    assert.deepEqual(labelEnum(labels, 'connection'), ['NOT_CONNECTED'], `${name}: 不接外部系统，不许放 CONNECTED`)
  }
})

// ---------------------------------------------------------------------------
//  3. 源码层：没有硬编码的出口标签，且三处共用同一份判定实现
// ---------------------------------------------------------------------------

test('源码扫描：三个工具文件里没有硬编码的 `provenance: \'LIVE\'` / `connection: \'CONNECTED\'`', () => {
  for (const file of ['interview-schedule.ts', 'job-create.ts', 'candidate-get.ts']) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    // 只看对象字面量（后面跟逗号），类型声明里的 `provenance: 'LIVE' | 'FIXTURE'` 不算硬编码。
    assert.doesNotMatch(source, /provenance:\s*'LIVE'\s*,/, `${file}: provenance 不许写死 LIVE（必须按租户事实算）`)
    assert.doesNotMatch(source, /connection:\s*'CONNECTED'\s*,/, `${file}: connection 不许写死 CONNECTED`)
  }
})

test('单一判定实现：三处都 import 同一个 buildThreeAxisLabels（不各写一份，防漂移）', () => {
  for (const [file, importer] of [
    ['interview-schedule.ts', /import \{ buildThreeAxisLabels \} from '\.\/candidate-get\.ts'/],
    ['job-create.ts', /import \{ buildThreeAxisLabels \} from '\.\/candidate-get\.ts'/],
    ['candidate-get.ts', /export async function buildThreeAxisLabels/],
  ] as const) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    assert.match(source, importer, `${file}: 必须共用 candidate-get.ts 的同一份判定实现`)
  }
})
