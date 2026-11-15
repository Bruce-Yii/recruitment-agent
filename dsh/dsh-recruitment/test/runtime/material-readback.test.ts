// P0-3（RESUME_PARSE 材料路径）· `readback.ts` 两个**只读**材料事实查询的真实库验收。
//
// 库纪律：`createRuntimeTestDatabase('p03_mat')` 一次性空库（0001→0016 顺序重放，
// 跑完 DROP）；夹具在**真提交**事务里造（`withActor`：BEGIN → SET LOCAL actor →
// 造数 → COMMIT），因为产品读路径（`withReadOnly` 各开一条连接）只能看见已提交行。
//
// 守的根因：DB 里材料只有 `intake_asset.storage_ref = content-addressed:sha256:<sha>`
// （**没有文件路径**），worker 的任务书要从不含路径的受控事实（文件名/mime/大小/sha/
// 内容寻址引用）出发去 allowed_roots 里按 sha 定位材料，而不是全盘搜索 → WORKER_TIMEOUT。
//   ① intake 正例：五项逐字与独立 SQL 读回一致（不拿返回值自证）；
//   ② application 正例：沿 resume_version → resume → intake_asset 反查到 seed 的那份资产；
//   ③ 不存在 / 没钉 resume_version → 空数组（不抛错、不拿相近行顶替）；
//   ④ tenant 判等不是装饰；
//   ⑤ 同一收件两条材料：全返回且按 created_at,id 稳定排序；
//   ⑥ `RuntimeStore` 两个委托与 readback 同值（B 的端口接的就是这里）。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { DatabaseClient } from '../../src/db/pool.ts'
import { withActor } from '../../src/db/pool.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import {
  materialsForApplication,
  materialsForIntakeRecord,
  type MaterialRow,
} from '../../src/runtime/store/readback.ts'
import { hex64, one, seedScenario, uniqueSuffix } from '../integration/db.ts'
import {
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  createRuntimeTestDatabase,
  type RuntimeTestDatabase,
} from './db.ts'

/** 一份能被 `seedScenario` 接受的 Rubric（本文件不跑筛选，只为满足外键与 payload_hash）。 */
const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months', label: '≥60 个月', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 60 },
] as const

/** 一个合法但库里不存在的 UUID 租户：只用来证明 tenant 判等不是装饰。 */
const OTHER_TENANT = '99999999-9999-4999-8999-000000000001'

let db: RuntimeTestDatabase
let store: RuntimeStore
let fx: Fixtures

/** `before` 里一次性造好、真提交的夹具 id 集合（断言里逐字比对）。 */
interface Fixtures {
  readonly applicationId: string
  readonly intakeRecordId: string
  readonly resumeVersionId: string
  readonly assetId: string
  readonly otherApplicationId: string
  readonly otherIntakeRecordId: string
  readonly otherAssetId: string
  readonly multiApplicationId: string
  readonly multiIntakeRecordId: string
  readonly multiAssetId: string
  readonly multiExtraAssetId: string
  readonly unboundApplicationId: string
  readonly unboundIntakeRecordId: string
}

before(async () => {
  db = await createRuntimeTestDatabase('p03_mat')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  // 真提交：readback 的 `withReadOnly` 走另开的连接，未提交的行它看不见。
  fx = await withActor(db.pool, RUNTIME_ACTOR, seedFixtures)
})

after(async () => {
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  夹具（测试代码故意直接写库：工具端点不提供造夹具入口）
// ---------------------------------------------------------------------------

/** 造全部夹具（在一个事务里调用；返回的 id 即库里已提交行的 id）。 */
async function seedFixtures(client: DatabaseClient): Promise<Fixtures> {
  // ① 单材料申请链：job → … → event/intake_asset/resume/resume_version → application。
  const base = await seedScenario(client, { dimensions: DIMENSIONS })
  const intakeRecordId = await intakeRecordIdOf(client, base.resumeVersionId)
  const assetId = await firstAssetIdOf(client, intakeRecordId)
  // 现场证据里的真实形态：`storage_ref` 是**内容寻址引用**，不是文件路径。
  await client.query(
    `update recruitment.intake_asset set storage_ref = 'content-addressed:sha256:' || sha256
      where tenant_id = $1 and id = $2`, [RUNTIME_TENANT, assetId],
  )

  // ② 另一条独立申请链（证明按 id 精确匹配，不是"取最近一条"）。
  const other = await seedScenario(client, { dimensions: DIMENSIONS })
  const otherIntakeRecordId = await intakeRecordIdOf(client, other.resumeVersionId)
  const otherAssetId = await firstAssetIdOf(client, otherIntakeRecordId)

  // ③ 同一收件两条 `intake_asset`（一封转发邮件多份资料的形态：多材料不丢、排序稳定）。
  const multi = await seedScenario(client, { dimensions: DIMENSIONS })
  const multiIntakeRecordId = await intakeRecordIdOf(client, multi.resumeVersionId)
  const multiAssetId = await firstAssetIdOf(client, multiIntakeRecordId)
  const extraSha = hex64(`p03-extra-${uniqueSuffix()}`)
  const multiExtraAssetId = await one(client, `insert into recruitment.intake_asset
      (tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref,
       validation_status, created_at)
      values ($1, $2, $3, 'application/octet-stream', 8192, $4, $5, 'VALID', now() + interval '1 minute')
      returning id`, [
    RUNTIME_TENANT, multiIntakeRecordId, `p03-material-b-${uniqueSuffix()}.bin`, extraSha,
    `content-addressed:sha256:${extraSha}`,
  ])

  // ④ 没钉 resume_version 的申请：材料在库里，但这条申请不引用它 → 链断必须空。
  const unbound = await seedScenario(client, { dimensions: DIMENSIONS, bindMaterial: false })
  const unboundIntakeRecordId = await intakeRecordIdOf(client, unbound.resumeVersionId)

  return {
    applicationId: base.applicationId,
    intakeRecordId,
    resumeVersionId: base.resumeVersionId,
    assetId,
    otherApplicationId: other.applicationId,
    otherIntakeRecordId,
    otherAssetId,
    multiApplicationId: multi.applicationId,
    multiIntakeRecordId,
    multiAssetId,
    multiExtraAssetId,
    unboundApplicationId: unbound.applicationId,
    unboundIntakeRecordId,
  }
}

/** 一份申请链的 `intake_record` id（`seedScenario` 返回的 id 集合里不含它，按物理链读回）。 */
async function intakeRecordIdOf(client: DatabaseClient, resumeVersionId: string): Promise<string> {
  return one(client, `select ir.id::text as id
        from recruitment.intake_record ir
        join recruitment.intake_asset ia
          on ia.intake_record_id = ir.id and ia.tenant_id = ir.tenant_id
        join recruitment.resume r
          on r.intake_asset_id = ia.id and r.tenant_id = ia.tenant_id
        join recruitment.resume_version rv
          on rv.resume_id = r.id and rv.tenant_id = r.tenant_id
       where rv.tenant_id = $1 and rv.id = $2`, [RUNTIME_TENANT, resumeVersionId])
}

/** 一份收件下的第一份材料 id（`order by created_at, id`，与产品读层同口径）。 */
async function firstAssetIdOf(client: DatabaseClient, intakeRecordId: string): Promise<string> {
  return one(client, `select id::text from recruitment.intake_asset
       where tenant_id = $1 and intake_record_id = $2
       order by created_at, id limit 1`, [RUNTIME_TENANT, intakeRecordId])
}

// ---------------------------------------------------------------------------
//  **独立读回**（不 import 产品代码；只读 SQL，证明断言不是拿返回值自证）
// ---------------------------------------------------------------------------

/** 按 id 直读一行 `intake_asset`（+ 它的收件 id），作为逐字比对的期望值。 */
async function assetFact(assetId: string): Promise<MaterialRow> {
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `select ir.id::text as intake_record_id, ia.id::text as asset_id,
            ia.file_name, ia.mime_type, ia.byte_size, ia.sha256, ia.storage_ref
       from recruitment.intake_asset ia
       join recruitment.intake_record ir
         on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
      where ia.tenant_id = $1 and ia.id = $2`,
    [RUNTIME_TENANT, assetId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`fixture asset not found: ${assetId}`)
  return {
    intakeRecordId: String(row.intake_record_id),
    assetId: String(row.asset_id),
    fileName: String(row.file_name),
    mimeType: row.mime_type === null ? null : String(row.mime_type),
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    storageRef: String(row.storage_ref),
  }
}

/** 一条申请沿版本链引用到的 asset id（独立 SQL；链断 → null）。 */
async function assetIdForApplication(applicationId: string): Promise<string | null> {
  const { rows } = await db.pool.query<{ asset_id: string }>(
    `select ia.id::text as asset_id
       from recruitment.application a
       join recruitment.resume_version rv
         on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
       join recruitment.resume r
         on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       join recruitment.intake_asset ia
         on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
      where a.tenant_id = $1 and a.id = $2`, [RUNTIME_TENANT, applicationId],
  )
  return rows[0]?.asset_id ?? null
}

/** 单值读回（多列也是取第一列；0 行说明夹具写错了，直接失败）。 */
async function scalar(sql: string, params: readonly unknown[]): Promise<string> {
  const { rows } = await db.pool.query<Record<string, unknown>>(sql, [...params])
  const value = rows[0] === undefined ? undefined : Object.values(rows[0])[0]
  if (typeof value !== 'string') throw new Error(`expected exactly 1 string row: ${sql.slice(0, 60)}`)
  return value
}

/** 单列多行读回。 */
async function column(sql: string, params: readonly unknown[]): Promise<string[]> {
  const { rows } = await db.pool.query<Record<string, unknown>>(sql, [...params])
  return rows.map((row) => String(Object.values(row)[0]))
}

// ---------------------------------------------------------------------------
//  验收
// ---------------------------------------------------------------------------

describe('P0-3 材料事实只读查询（fresh 空库 + 真提交夹具）', () => {
  test('materialsForIntakeRecord：五项与独立 SQL 读回逐字一致，storage_ref 是内容寻址引用（不是路径）', async () => {
    const rows = await materialsForIntakeRecord(db.pool, RUNTIME_TENANT, fx.intakeRecordId)
    assert.equal(rows.length, 1)
    // 逐字：与独立 SQL 读回整行一致（含 mime / bigint byte_size 的映射）。
    const expected = await assetFact(fx.assetId)
    assert.deepEqual(rows, [expected])
    // 再钉死 seedScenario 的三个字面量：证明没有"顺便取相近行"。
    assert.equal(expected.intakeRecordId, fx.intakeRecordId)
    assert.equal(expected.fileName, 'test.pdf')
    assert.equal(expected.mimeType, 'application/pdf')
    assert.equal(expected.byteSize, 1024)
    // sha 与**另一张表**（resume_version.source_asset_sha256）一致，不是拿返回值自证。
    const chainSha = await scalar(
      `select source_asset_sha256 from recruitment.resume_version
        where tenant_id = $1 and id = $2`, [RUNTIME_TENANT, fx.resumeVersionId],
    )
    assert.equal(expected.sha256, chainSha)
    assert.match(expected.sha256, /^[0-9a-f]{64}$/)
    // 现场证据的形态：`content-addressed:sha256:<sha>`，**没有文件路径**（路径不进 DB）。
    assert.equal(expected.storageRef, `content-addressed:sha256:${expected.sha256}`)
  })

  test('materialsForApplication：沿 resume_version → resume → intake_asset 反查到 seedScenario 那份资产', async () => {
    // 独立 SQL 先证明这条申请的版本链确实指向这份 asset。
    assert.equal(await assetIdForApplication(fx.applicationId), fx.assetId)
    assert.deepEqual(
      await materialsForApplication(db.pool, RUNTIME_TENANT, fx.applicationId),
      [await assetFact(fx.assetId)],
    )
  })

  test('不存在的 id / 没钉 resume_version → 空数组（不抛错、不拿相近行顶替）', async () => {
    const missing = randomUUID()
    assert.deepEqual(await materialsForIntakeRecord(db.pool, RUNTIME_TENANT, missing), [])
    assert.deepEqual(await materialsForApplication(db.pool, RUNTIME_TENANT, missing), [])

    // 材料在库里、但这条申请没钉 resume_version：申请侧读不到，收件侧读得到（证明确实是链断）。
    assert.equal(await assetIdForApplication(fx.unboundApplicationId), null)
    assert.deepEqual(await materialsForApplication(db.pool, RUNTIME_TENANT, fx.unboundApplicationId), [])
    assert.equal((await materialsForIntakeRecord(db.pool, RUNTIME_TENANT, fx.unboundIntakeRecordId)).length, 1)

    // 两条申请各有各的材料：按 id 精确匹配，不是"取最近一条"。
    assert.notEqual(fx.assetId, fx.otherAssetId)
    assert.deepEqual(
      await materialsForApplication(db.pool, RUNTIME_TENANT, fx.otherApplicationId),
      [await assetFact(fx.otherAssetId)],
    )
    assert.deepEqual(
      await materialsForIntakeRecord(db.pool, RUNTIME_TENANT, fx.otherIntakeRecordId),
      [await assetFact(fx.otherAssetId)],
    )
  })

  test('tenant 判等不是装饰：换租户 id 读不到同一批材料（同租户读得到）', async () => {
    assert.deepEqual(await materialsForIntakeRecord(db.pool, OTHER_TENANT, fx.intakeRecordId), [])
    assert.deepEqual(await materialsForIntakeRecord(db.pool, OTHER_TENANT, fx.multiIntakeRecordId), [])
    assert.deepEqual(await materialsForApplication(db.pool, OTHER_TENANT, fx.applicationId), [])
    assert.deepEqual(await materialsForApplication(db.pool, OTHER_TENANT, fx.multiApplicationId), [])
    // 对照：同一批 id 在本租户下非空，说明上面的空是 tenant 过滤而不是查询坏了。
    assert.equal((await materialsForIntakeRecord(db.pool, RUNTIME_TENANT, fx.intakeRecordId)).length, 1)
    assert.equal((await materialsForApplication(db.pool, RUNTIME_TENANT, fx.multiApplicationId)).length, 1)
  })

  test('同一收件两条材料 → 全返回且按 created_at,id 稳定排序（重复调用同序）', async () => {
    const first = await materialsForIntakeRecord(db.pool, RUNTIME_TENANT, fx.multiIntakeRecordId)
    assert.equal(first.length, 2)
    // 期望顺序由独立 SQL 给出（不手写假设）。
    const orderFromDb = await column(
      `select id::text from recruitment.intake_asset
        where tenant_id = $1 and intake_record_id = $2
        order by created_at, id`, [RUNTIME_TENANT, fx.multiIntakeRecordId],
    )
    assert.deepEqual(first.map((row) => row.assetId), orderFromDb)
    // 第二份材料是后插的（created_at 更晚）：内容寻址引用逐字保留，不丢、不合并。
    assert.deepEqual(first, [await assetFact(fx.multiAssetId), await assetFact(fx.multiExtraAssetId)])
    assert.equal(first[1].storageRef, `content-addressed:sha256:${first[1].sha256}`)
    // 稳定：再读一次同序（读层无缓存、无随机排序）。
    assert.deepEqual(await materialsForIntakeRecord(db.pool, RUNTIME_TENANT, fx.multiIntakeRecordId), first)
    // 申请只钉第一份：同一收件的第二份材料不会被混进 application 结果。
    assert.deepEqual(
      await materialsForApplication(db.pool, RUNTIME_TENANT, fx.multiApplicationId),
      [await assetFact(fx.multiAssetId)],
    )
  })

  test('RuntimeStore 两个委托与 readback 同值（B 的端口接的就是这里）', async () => {
    assert.deepEqual(
      await store.materialsForIntakeRecord(fx.intakeRecordId),
      await materialsForIntakeRecord(db.pool, RUNTIME_TENANT, fx.intakeRecordId),
    )
    assert.deepEqual(
      await store.materialsForApplication(fx.applicationId),
      await materialsForApplication(db.pool, RUNTIME_TENANT, fx.applicationId),
    )
    assert.equal((await store.materialsForIntakeRecord(fx.multiIntakeRecordId)).length, 2)
    // 委托吃的是 store 自己的 tenant：换租户的 store 读不到。
    const otherStore = new RuntimeStore({ pool: db.pool, tenantId: OTHER_TENANT, actorId: RUNTIME_ACTOR })
    assert.deepEqual(await otherStore.materialsForApplication(fx.applicationId), [])
    assert.deepEqual(await otherStore.materialsForIntakeRecord(fx.intakeRecordId), [])
  })
})
