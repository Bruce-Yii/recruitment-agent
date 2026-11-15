// P0-3：**真库**集成测试——任务书 MATERIAL 段 + 真材料路径解析（fresh 一次性空库）。
//
// 守的是现场根因的反面（CONTRACT §2.4）：
//   `intake_asset` 只有 `content-addressed:sha256:<sha>`（无路径）时，任务书只能给
//   sha/file_name → 真 Agent 全盘搜索 → 180s WORKER_TIMEOUT。这里用**真提交**夹具 +
//   真 `RuntimeStore` 材料只读查询 + 真合成文件（字节 sha 与 `intake_asset.sha256` 一致），
//   断言任务书里出现**真实存在**的 `material_path` / `material_workspace_ref`；
//   负例（允许根不命中）→ `MATERIAL UNKNOWN` 且没有 material_path（不猜路径）。
//
// 依赖：A lane 的 `RuntimeStore.materialsForIntakeRecord` / `materialsForApplication`。
// 夹具只写一次性库；材料文件是测试自建的**合成字节**（不碰任何真实候选人资料）。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { DatabaseClient } from '../../src/db/pool.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import {
  buildWorkerPrompt,
  createStoreTaskContextSource,
  TASK_CONTEXT_SECTIONS,
} from '../../src/runtime/task-context.ts'
import type { WorkerTaskRequest } from '../../src/runtime/types.ts'
import { one, seedScenario } from '../integration/db.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from './db.ts'

/** 合法的 rubric dimensions（seedScenario 会自己算 payload_hash）。 */
const RUBRIC_DIMENSIONS = [{ key: 'skill', label: '技能' }]
/** 任务书投影里的占位工作目录（不是本机真实路径；本测试不起 worker 进程）。 */
const WORKSPACE_DIR = 'D:/work/runtime/p03-material'
/** 测试自建合成材料的文件名（与 P0-3 现场失败的那份同名，便于对照）。 */
const MATERIAL_FILE_NAME = 'gate1-probe-resume.pdf'

let db: RuntimeTestDatabase
let store: RuntimeStore
let materialRoot: { readonly dir: string; cleanup: () => void }

/** 正例夹具：真提交后读回的 id + 合成材料字节事实。 */
interface MaterialFixture {
  readonly applicationId: string
  readonly intakeRecordId: string
  readonly eventId: string
  readonly taskId: string
  readonly description: string
  readonly sha256: string
  readonly byteSize: number
  readonly filePath: string
}

let fixture: MaterialFixture

/** 合成材料的字节（放临时目录；sha256 与 intake_asset.sha256 一致）。 */
function syntheticMaterialBytes(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n% P0-3 synthetic resume material (unit/integration fixture, not a real candidate)\n'
    + '1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
    'utf8',
  )
}

before(async () => {
  materialRoot = makeTempDir('rt-material-root')
  db = await createRuntimeTestDatabase('p03_mat_ctx')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  fixture = await createMaterialFixture()
})

after(async () => {
  materialRoot?.cleanup()
  if (db !== undefined) await db.drop()
})

/** 真实临时目录（跑完删干净）。 */
function makeTempDir(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 在**真提交**的事务里造夹具。 */
async function commitOnce<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [RUNTIME_ACTOR])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 一条 RESUME_PARSE 的 business_task（列与 `store/events.ts` 的创建行同形）。 */
async function insertResumeParseTask(
  client: DatabaseClient,
  input: {
    readonly intakeRecordId: string
    readonly eventId: string
    readonly description: string
    readonly seed: string
  },
): Promise<string> {
  return one(client, `insert into recruitment.business_task
      (tenant_id, task_type, business_refs, title, description, priority,
       trigger_event_id, created_by_actor_id, idempotency_key, status, next_run_at)
    values ($1, 'RESUME_PARSE', $2::jsonb, '解析简历', $3, 3,
            $4, $5, $6, 'PENDING', now())
    returning id::text`, [
    RUNTIME_TENANT,
    JSON.stringify([{ type: 'INTAKE_RECORD', id: input.intakeRecordId }]),
    input.description,
    input.eventId,
    RUNTIME_ACTOR,
    `task:RESUME_PARSE:INTAKE_RECORD:${input.seed}`,
  ])
}

/**
 * 正例夹具：`seedScenario` 造完整 intake/application 链 → 把 `intake_asset` 的
 * sha256/byte_size/file_name 改成**真实合成字节**（A 的查询读的就是这一行）→
 * 插一条 RESUME_PARSE 任务（business_refs=[INTAKE_RECORD]，description 指回真事件）。
 * @returns 真提交后可用的 id 与合成材料事实。
 */
async function createMaterialFixture(): Promise<MaterialFixture> {
  const seed = randomUUID().slice(0, 8)
  const bytes = syntheticMaterialBytes()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const filePath = join(materialRoot.dir, MATERIAL_FILE_NAME)
  writeFileSync(filePath, bytes)

  return commitOnce(async (client) => {
    const scenario = await seedScenario(client, { dimensions: RUBRIC_DIMENSIONS })
    // seedScenario 造的 intake 链（用 resume_version 反查，不猜 id）。asset sha 先取出来再改。
    const chain = await client.query<{
      intake_record_id: string
      asset_id: string
      event_id: string
    }>(
      `select ir.id::text as intake_record_id, ia.id::text as asset_id, ir.event_id::text as event_id
         from recruitment.resume_version rv
         join recruitment.resume r
           on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
         join recruitment.intake_asset ia
           on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
         join recruitment.intake_record ir
           on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
        where rv.tenant_id = $1 and rv.id = $2`,
      [RUNTIME_TENANT, scenario.resumeVersionId],
    )
    const chainRow = chain.rows[0]
    assert.ok(chainRow !== undefined, 'seedScenario did not create the intake chain')

    // 把 intake_asset 指向**真实存在的合成字节**：sha/大小/文件名三者必须与文件一致，
    // 否则 A 的查询读到的是"库里说 1024B 的 test.pdf"，永远解析不到路径。
    await client.query(
      `update recruitment.intake_asset
          set file_name = $2, mime_type = 'application/pdf', byte_size = $3,
              sha256 = $4, storage_ref = $5, validation_status = 'VALID', validation_error = null
        where tenant_id = $1 and id = $6::uuid`,
      [
        RUNTIME_TENANT,
        MATERIAL_FILE_NAME,
        bytes.length,
        sha256,
        `content-addressed:sha256:${sha256}`,
        chainRow.asset_id,
      ],
    )

    const description = `deterministic event ${EVENT_TYPES.RESUME_INTAKE_RECEIVED} (event ${chainRow.event_id})`
    const taskId = await insertResumeParseTask(client, {
      intakeRecordId: chainRow.intake_record_id,
      eventId: chainRow.event_id,
      description,
      seed: `${seed}-p03-material`,
    })

    return {
      applicationId: scenario.applicationId,
      intakeRecordId: chainRow.intake_record_id,
      eventId: chainRow.event_id,
      taskId,
      description,
      sha256,
      byteSize: bytes.length,
      filePath,
    }
  })
}

/** 把 worker 投影拼出来（与 `task-runtime.ts` 的 WorkerTaskRequest 字段一致）。 */
function makeRequest(input: {
  readonly taskId: string
  readonly description: string | null
  readonly businessRefs: WorkerTaskRequest['businessRefs']
}): WorkerTaskRequest {
  return {
    taskId: input.taskId,
    attemptId: randomUUID(),
    attemptNo: 1,
    taskType: 'RESUME_PARSE',
    title: '解析简历',
    description: input.description,
    businessRefs: input.businessRefs,
    prompt: '',
    resumeSessionId: null,
    workspaceDir: WORKSPACE_DIR,
  }
}

/** 取任务书里的 MATERIAL 段（标题 → 下一个段标题 VERSION PINS）。 */
function materialSection(prompt: string): string {
  const start = prompt.indexOf(TASK_CONTEXT_SECTIONS.material)
  assert.ok(start >= 0, 'prompt is missing the MATERIAL section')
  const end = prompt.indexOf(TASK_CONTEXT_SECTIONS.versionPins, start + TASK_CONTEXT_SECTIONS.material.length)
  assert.ok(end > start, 'MATERIAL section must end before VERSION PINS')
  return prompt.slice(start, end)
}

describe('P0-3 MATERIAL with real RuntimeStore (fresh DB)', () => {
  test('INTAKE_RECORD task: materials[0].material_path is a real file and the prompt renders it', async () => {
    const request = makeRequest({
      taskId: fixture.taskId,
      description: fixture.description,
      businessRefs: [{ type: 'INTAKE_RECORD', id: fixture.intakeRecordId }],
    })
    const facts = await createStoreTaskContextSource(store, { material: { roots: [materialRoot.dir] } }).load(request)
    assert.ok(facts !== null, 'store-backed source must return facts')

    // 材料事实：只有一份（seedScenario 的 resume 链那一份），字段逐字等于合成文件。
    assert.equal(facts.materials?.length, 1)
    const material = facts.materials?.[0]
    assert.ok(material !== undefined)
    assert.equal(material.file_name, MATERIAL_FILE_NAME)
    assert.equal(material.sha256, fixture.sha256)
    assert.equal(material.byte_size, fixture.byteSize)
    assert.equal(material.mime_type, 'application/pdf')
    assert.equal(material.storage_ref, `content-addressed:sha256:${fixture.sha256}`)
    assert.equal(material.material_path, fixture.filePath, 'material_path must be the verified synthetic file')
    assert.equal(existsSync(material.material_path ?? ''), true, 'material_path must exist on disk')
    assert.equal(resolve(material.material_path ?? ''), resolve(fixture.filePath))
    assert.equal(material.workspace_ref, `materials/${MATERIAL_FILE_NAME}`)
    assert.ok((material.workspace_ref ?? '').startsWith('materials/'))

    // 证据 locator：kind=material / ref=sha（路径不进 locator 的 ref）。
    const locator = facts.evidence_locators.find((candidate) => candidate.kind === 'material')
    assert.ok(locator !== undefined, 'a resolved material must add a material locator')
    assert.equal(locator.ref, fixture.sha256)

    // 任务书：MATERIAL 段里是**真实路径**，不是"去找吧"。
    const prompt = buildWorkerPrompt(request, facts)
    const section = materialSection(prompt)
    assert.ok(section.includes(`material_path: ${fixture.filePath}  (verified: allowed_roots + file bytes sha256)`))
    assert.ok(section.includes(`material_workspace_ref: materials/${MATERIAL_FILE_NAME}  (copied into the session workspace by the launcher)`))
    assert.ok(section.includes(`sha256=${fixture.sha256}`))
    assert.equal(section.includes('MATERIAL UNKNOWN'), false)

    console.log('\n===== RENDERED MATERIAL (real DB fixture + real file) =====')
    console.log(section.trim())
    console.log('===== END RENDERED MATERIAL =====\n')
  })

  test('APPLICATION task: materialsForApplication resolves the same verified material', async () => {
    const request = makeRequest({
      taskId: fixture.taskId,
      description: fixture.description,
      businessRefs: [{ type: 'APPLICATION', id: fixture.applicationId }],
    })
    const facts = await createStoreTaskContextSource(store, { material: { roots: [materialRoot.dir] } }).load(request)
    assert.ok(facts !== null)
    const material = facts.materials?.[0]
    assert.ok(material !== undefined, 'application chain must resolve one material')
    assert.equal(material.sha256, fixture.sha256)
    assert.equal(material.material_path, fixture.filePath)
    assert.equal(material.workspace_ref, `materials/${MATERIAL_FILE_NAME}`)
    const prompt = buildWorkerPrompt(request, facts)
    assert.ok(materialSection(prompt).includes(`material_path: ${fixture.filePath}`))
  })

  test('negative: an allowed root without the file yields MATERIAL UNKNOWN and no material_path', async () => {
    const emptyRoot = makeTempDir('rt-material-empty')
    try {
      const request = makeRequest({
        taskId: fixture.taskId,
        description: fixture.description,
        businessRefs: [{ type: 'INTAKE_RECORD', id: fixture.intakeRecordId }],
      })
      const facts = await createStoreTaskContextSource(store, { material: { roots: [emptyRoot.dir] } }).load(request)
      assert.ok(facts !== null)
      const material = facts.materials?.[0]
      assert.ok(material !== undefined, 'the material fact itself must still be reported')
      assert.equal(material.material_path, undefined, 'must not invent a material path')
      assert.equal(material.workspace_ref, undefined)
      assert.match(material.source ?? '', /^allowed_roots_lookup:NOT_FOUND_IN_ALLOWED_ROOTS;checked_roots=1$/)

      const prompt = buildWorkerPrompt(request, facts)
      const section = materialSection(prompt)
      assert.ok(
        section.includes(`- MATERIAL UNKNOWN: ${MATERIAL_FILE_NAME} sha256=${fixture.sha256} — NOT_FOUND_IN_ALLOWED_ROOTS (checked 1 allowed roots; do not invent a path)`),
        `MATERIAL UNKNOWN line is missing\n---\n${section}`,
      )
      assert.equal(section.includes('material_path:'), false)
      assert.equal(section.includes('material_workspace_ref:'), false)
    } finally {
      emptyRoot.cleanup()
    }
  })

  test('negative: no allowed roots at all is NO_ALLOWED_ROOTS (never a cwd guess)', async () => {
    const request = makeRequest({
      taskId: fixture.taskId,
      description: fixture.description,
      businessRefs: [{ type: 'INTAKE_RECORD', id: fixture.intakeRecordId }],
    })
    const facts = await createStoreTaskContextSource(store, { material: { roots: [] } }).load(request)
    assert.ok(facts !== null)
    const material = facts.materials?.[0]
    assert.ok(material !== undefined)
    assert.equal(material.material_path, undefined)
    assert.match(material.source ?? '', /^allowed_roots_lookup:NO_ALLOWED_ROOTS;checked_roots=0$/)
    assert.match(materialSection(buildWorkerPrompt(request, facts)), /NO_ALLOWED_ROOTS/)
  })

  test('the material row for a nonexistent intake_record stays empty (no fabricated material)', async () => {
    const request = makeRequest({
      taskId: fixture.taskId,
      description: null,
      businessRefs: [{ type: 'INTAKE_RECORD', id: randomUUID() }],
    })
    const facts = await createStoreTaskContextSource(store, { material: { roots: [materialRoot.dir] } }).load(request)
    assert.ok(facts !== null)
    assert.equal(facts.materials?.length, 0)
    assert.match(materialSection(buildWorkerPrompt(request, facts)), /no material is referenced by this task's business objects/)
  })
})
