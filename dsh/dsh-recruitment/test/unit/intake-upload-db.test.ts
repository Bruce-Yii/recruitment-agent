// intake-upload DB+FS 层的单元测试。
//
// 覆盖：
//   1. 所有「零写入 fail-closed」路径（在 import pg / 落盘之前就返回）—— 永远真跑；
//   2. 真库成功路径 / 幂等路径 —— 通过 RECRUITMENT_DB_PASSWORD 显式 opt-in，
//      复用 test/integration/db.ts 的一次性空库 harness，断言独立 SQL 读回；
//   3. sha256 不一致路径 —— 生产实现用 node:fs/promises 直接写/读，没有可注入的
//      FS 故障 seam；这是**声明式 standing skip**（原因固定，见 SKIP_FS_SEAM），
//      不伪装成通过，也不放在默认绿口径里当作"跑过了"。
//
// 跳过不是通过（R3/E2）：默认无 DB 时只跳过 2 条真库用例，跳过原因逐条写明；
// 有 DB 时这 2 条真跑，standing skip 恒为 1 条并在 CI skip 声明清单里登记。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'

import {
  INTAKE_UPLOAD_CONTENT_TYPES,
  INTAKE_UPLOAD_PATH,
  MAX_UPLOAD_BYTES,
  createIntakeUploadTask,
  type IntakeUploadDeps,
  type IntakeUploadInput,
} from '../../src/db/intake-upload.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from '../integration/db.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const ACTOR = '11111111-1111-4111-8111-000000000103'
const JOB = '22222222-2222-4222-8222-000000000001'

/** 最小的「已配置」数据库占位：fail-fast 用例不会真的拿它建连。 */
const fakeDatabase = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_test_never_connected',
  password: 'unused',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT,
  actor_id: ACTOR,
  statement_timeout_ms: 1000,
  connect_timeout_ms: 1000,
  max: 1,
}

function baseInput(overrides: Partial<IntakeUploadInput> = {}): IntakeUploadInput {
  return {
    bytes: Buffer.from('%PDF-1.4 test'),
    contentType: 'application/pdf',
    fileName: 'resume.pdf',
    tenantId: TENANT,
    actorId: ACTOR,
    jobId: JOB,
    ...overrides,
  }
}

function deps(overrides: Partial<IntakeUploadDeps> = {}): IntakeUploadDeps {
  return {
    database: fakeDatabase,
    converter: { allowed_roots: ['C:\\intake-allowed-root'] },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
//  真库 opt-in 门（与 test/integration/db.ts 同一份环境探测，不另造第二套）
// ---------------------------------------------------------------------------

/** 缺 DB 口令/连不上时的跳过原因（不含密码/密钥）。 */
function pgSkipReason(): string | false {
  try {
    testDatabaseConfig()
    return false
  } catch (error) {
    return `真库 opt-in 未开启：${error instanceof Error ? error.message.slice(0, 180) : String(error)}`
  }
}
const SKIP_PG = pgSkipReason()

/** 固定的 standing-skip 原因：CI 的 skip 声明清单按这段逐条匹配。 */
const SKIP_FS_SEAM = 'STANDING SKIP: intake-upload SHA256_MISMATCH needs a filesystem fault-injection seam; '
  + 'production writes/reads with node:fs/promises directly (no injectable seam). '
  + 'Not a pass — the branch is covered only by code review until a seam is added.'

/** 给真库用例用的最小夹具：一次性空库 + 临时 allowed_root，用完即删。 */
async function withRealUploadHarness(
  label: string,
  run: (ctx: {
    db: IsolatedTestDatabase
    allowedRoot: string
    deps: IntakeUploadDeps
  }) => Promise<void>,
): Promise<void> {
  const db = await createIsolatedTestDatabase(label)
  assertPrivateDatabase(db.name)
  const allowedRoot = await mkdtemp(join(tmpdir(), `ra-upload-unit-${label}-`))
  try {
    const base = testDatabaseConfig()
    await run({
      db,
      allowedRoot,
      deps: {
        database: { ...base, database: db.name },
        converter: { allowed_roots: [allowedRoot] },
      },
    })
  } finally {
    await rm(allowedRoot, { recursive: true, force: true }).catch(() => undefined)
    await db.drop()
  }
}

/** 独立 SQL 读回：不 import 产品 DAO 自证（L2）。 */
async function uploadRows(db: IsolatedTestDatabase, sha256: string): Promise<{
  eventIds: string[]
  taskIds: string[]
}> {
  const events = await db.pool.query<{ event_id: string }>(
    `select event_id::text as event_id from recruitment.event_inbox
      where tenant_id = $1 and idempotency_key = $2 order by event_id`,
    [TENANT, `resume.intake:${sha256}`],
  )
  const tasks = await db.pool.query<{ id: string }>(
    `select id::text as id from recruitment.business_task
      where tenant_id = $1 and idempotency_key = $2 order by id`,
    [TENANT, `task:RESUME_PARSE:INTAKE_RECORD:${sha256}`],
  )
  return {
    eventIds: events.rows.map((r) => r.event_id),
    taskIds: tasks.rows.map((r) => r.id),
  }
}

describe('intake-upload 常量契约', () => {
  test('路径 / 大小上限 / 内容类型白名单逐字符锁定', () => {
    assert.equal(INTAKE_UPLOAD_PATH, '/recruitment/api/intake/upload')
    assert.equal(MAX_UPLOAD_BYTES, 20 * 1024 * 1024)
    assert.deepEqual([...INTAKE_UPLOAD_CONTENT_TYPES], [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png',
      'image/jpeg',
    ])
  })
})

describe('零写入 fail-closed（在 import pg / 落盘之前返回）', () => {
  test('database=null → NOT_CONFIGURED，哪怕内容类型也不合法也先报未配置', async () => {
    const result = await createIntakeUploadTask(
      deps({ database: null }),
      baseInput({ contentType: 'application/x-evil' }),
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'NOT_CONFIGURED')
  })

  test('不支持的 contentType → UNSUPPORTED_MEDIA_TYPE', async () => {
    const result = await createIntakeUploadTask(deps(), baseInput({ contentType: 'text/html' }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'UNSUPPORTED_MEDIA_TYPE')
      assert.match(result.reason, /不支持的文件类型/)
    }
  })

  test('超 20MB → FILE_TOO_LARGE（用稀疏 Buffer 构造，不真分配 20MB 内容）', async () => {
    const huge = Buffer.alloc(MAX_UPLOAD_BYTES + 1)
    const result = await createIntakeUploadTask(deps(), baseInput({ bytes: huge }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'FILE_TOO_LARGE')
  })

  test('文件名含 ../ → INVALID_FILE_NAME，绝不 strip 后继续', async () => {
    for (const fileName of ['../evil.pdf', 'a/b.pdf', 'a\\b.pdf', '', '..', 'x\u0000y.pdf']) {
      const result = await createIntakeUploadTask(deps(), baseInput({ fileName }))
      assert.equal(result.ok, false, `fileName=${JSON.stringify(fileName)} 应被拒`)
      if (!result.ok) assert.equal(result.code, 'INVALID_FILE_NAME')
    }
  })

  test('双重 URL 编码穿越 %252E... → INVALID_FILE_NAME（二次解码后含 ../）', async () => {
    const result = await createIntakeUploadTask(
      deps(),
      baseInput({ fileName: '%252E%252E%252Fetc.pdf' }),
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'INVALID_FILE_NAME')
  })

  test('文件名 > 200 字符 → INVALID_FILE_NAME', async () => {
    const result = await createIntakeUploadTask(deps(), baseInput({ fileName: 'a'.repeat(201) }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'INVALID_FILE_NAME')
  })

  test('actor/tenant/job 非 UUID → WRITE_IDENTITY_REQUIRED', async () => {
    const result = await createIntakeUploadTask(deps(), baseInput({ actorId: 'not-a-uuid' }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'WRITE_IDENTITY_REQUIRED')
  })

  test('allowed_roots 为空 → OUTSIDE_ALLOWED_ROOTS，零写入', async () => {
    const result = await createIntakeUploadTask(
      deps({ converter: { allowed_roots: [] } }),
      baseInput(),
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'OUTSIDE_ALLOWED_ROOTS')
  })

  test('allowed_roots 含相对路径 → OUTSIDE_ALLOWED_ROOTS（不按 cwd 猜）', async () => {
    const result = await createIntakeUploadTask(
      deps({ converter: { allowed_roots: ['relative-dir'] } }),
      baseInput(),
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'OUTSIDE_ALLOWED_ROOTS')
  })
})

describe('需要真库 / 故障注入的路径（显式 opt-in，skip 不等于通过）', () => {
  test('成功落盘 + 复算 sha256 + 建任务（真库 opt-in：RECRUITMENT_DB_PASSWORD）', { skip: SKIP_PG }, async () => {
    const bytes = Buffer.from(`%PDF-1.4 unit-upload-${randomUUID()}`)
    const expectedSha = createHash('sha256').update(bytes).digest('hex')
    await withRealUploadHarness('uploadok', async ({ db, allowedRoot, deps: realDeps }) => {
      const result = await createIntakeUploadTask(realDeps, baseInput({ bytes }))
      assert.equal(result.ok, true, `上传应成功：${result.ok === false ? result.reason : ''}`)
      if (!result.ok) return
      assert.equal(result.status, 'RUNNING')
      assert.equal(result.sha256, expectedSha, '返回的 sha256 必须是内存字节的真实摘要')
      assert.equal(result.byte_size, bytes.length)
      assert.match(result.task_id, /^[0-9a-f-]{36}$/i)
      assert.match(result.event_id, /^[0-9a-f-]{36}$/i)

      // 落盘文件真实存在且字节一致（读回复算，而不是信返回值）。
      const onDisk = await readFile(result.material_path)
      assert.equal(createHash('sha256').update(onDisk).digest('hex'), expectedSha)

      // 独立 SQL 读回：恰好 1 条 event + 1 条 task，且引用同一个 sha。
      const rows = await uploadRows(db, expectedSha)
      assert.equal(rows.eventIds.length, 1, `event_inbox 应恰好 1 行：${JSON.stringify(rows.eventIds)}`)
      assert.equal(rows.eventIds[0], result.event_id)
      assert.equal(rows.taskIds.length, 1, `business_task 应恰好 1 行：${JSON.stringify(rows.taskIds)}`)
      assert.equal(rows.taskIds[0], result.task_id)
      assert.ok(result.material_path.startsWith(allowedRoot), 'material_path 必须落在 allowed_root 内')
    })
  })

  test('磁盘 sha256 与内存不一致 → SHA256_MISMATCH 且清理文件（需可注入的文件系统故障 seam）', {
    skip: SKIP_FS_SEAM,
  }, async () => {
    assert.fail('unreachable — standing skip；见 SKIP_FS_SEAM 与 test/SKIPS.md')
  })

  test('重复上传同一 sha256 → 复用既有 event_id / task_id（真库 opt-in）', { skip: SKIP_PG }, async () => {
    const bytes = Buffer.from(`%PDF-1.4 idempotent-${randomUUID()}`)
    const expectedSha = createHash('sha256').update(bytes).digest('hex')
    await withRealUploadHarness('uploadidem', async ({ db, deps: realDeps }) => {
      const first = await createIntakeUploadTask(realDeps, baseInput({ bytes }))
      assert.equal(first.ok, true, `首次上传应成功：${first.ok === false ? first.reason : ''}`)
      if (!first.ok) return
      const second = await createIntakeUploadTask(realDeps, baseInput({ bytes, fileName: 'resume-again.pdf' }))
      assert.equal(second.ok, true, `重复上传应成功：${second.ok === false ? second.reason : ''}`)
      if (!second.ok) return

      // 内容寻址幂等：同 sha 必须复用同一 event_id / task_id。
      assert.equal(second.event_id, first.event_id, '重复上传必须复用 event_id')
      assert.equal(second.task_id, first.task_id, '重复上传必须复用 task_id')
      assert.equal(second.sha256, expectedSha)

      // 独立 SQL 读回：行数不增，仍各 1 行。
      const rows = await uploadRows(db, expectedSha)
      assert.equal(rows.eventIds.length, 1, `event_inbox 不得因重复上传变成 2 行：${JSON.stringify(rows.eventIds)}`)
      assert.equal(rows.taskIds.length, 1, `business_task 不得因重复上传变成 2 行：${JSON.stringify(rows.taskIds)}`)
    })
  })
})
