// intake-upload DB+FS 层的纯单元测试（不连真库、不写产品目录）。
//
// 覆盖：所有「零写入 fail-closed」路径（这些分支在 import pg / 落盘之前就返回）。
// DB 成功路径与 sha256 不一致路径需要真库 / 可控文件系统故障注入，本测试集没有
// 对应 seam，按任务书要求标 skip 并写明原因，绝不伪造 PASS。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  INTAKE_UPLOAD_CONTENT_TYPES,
  INTAKE_UPLOAD_PATH,
  MAX_UPLOAD_BYTES,
  createIntakeUploadTask,
  type IntakeUploadDeps,
  type IntakeUploadInput,
} from '../../src/db/intake-upload.ts'

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

describe('需要真库 / 故障注入的路径（未配置 seam，诚实跳过）', () => {
  test('成功落盘 + 复算 sha256 + 建任务（需一次性测试库，按 AGENTS.md 规范另建）', {
    skip: '本 lane 禁止新建迁移/改 db/verify.sql，且无测试库 seam；成功路径由父 lane 的 HTTP 端到端证据覆盖',
  }, async () => {
    assert.fail('unreachable')
  })

  test('磁盘 sha256 与内存不一致 → SHA256_MISMATCH 且清理文件（需可注入的文件系统故障 seam）', {
    skip: '当前实现用 node:fs/promises，测试无法在校验前篡改落盘字节；无 seam，不伪造绿色',
  }, async () => {
    assert.fail('unreachable')
  })

  test('重复上传同一 sha256 → 复用既有 event_id / task_id（需真库验证幂等）', {
    skip: '需真库写入两次读回行数；本测试集只做纯单元',
  }, async () => {
    assert.fail('unreachable')
  })
})
