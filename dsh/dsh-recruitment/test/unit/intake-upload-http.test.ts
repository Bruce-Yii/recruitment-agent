// 上传入口的纯校验层单测（不连库、不起服务、不写文件）。
//
// 冻结契约（src/http/intake-upload.ts 的真实导出）：
//   - `UPLOAD_PATH` = '/recruitment/api/intake/upload'
//   - `MAX_UPLOAD_BODY_BYTES` = 20 MiB（由 DB 层 MAX_UPLOAD_BYTES 别名而来）
//   - `UPLOAD_CONTENT_TYPES` = 4 个白名单 MIME（readonly string[]，用 .includes）
//   - `sanitizeUploadFileName(raw)` → 安全 basename；非法 → 抛 UploadHttpProblem
//   - `validateUploadHeaders(req, port, identity)` → {actorId,sessionId}；非法 → 抛 UploadHttpProblem
//
// 铁律：这些是纯函数，失败路径在碰 DB/文件之前就抛。这里用**没有绑定任何 session**
// 的 identity 做负例：若主机头/同源头/文件名/content-type 的闸门失效，进入身份解析后
// 必然失败（DEMO_ACTOR_UNMAPPED），因此"拒绝码必须是对应的闸门码"本身就是零写入证明。
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'

import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'
import {
  MAX_UPLOAD_BODY_BYTES,
  UPLOAD_CONTENT_TYPES,
  UPLOAD_PATH,
  UploadHttpProblem,
  normalizeContentType,
  sanitizeUploadFileName,
  validateContentType,
  validateJobId,
  validateUploadHeaders,
} from '../../src/http/intake-upload.ts'

// ---------------------------------------------------------------------------
//  常量：路径 / 20MiB / 白名单必须字面正确（不许"差不多"）
// ---------------------------------------------------------------------------

test('常量：UPLOAD_PATH / MAX_UPLOAD_BODY_BYTES / UPLOAD_CONTENT_TYPES 与契约逐字一致', () => {
  assert.equal(UPLOAD_PATH, '/recruitment/api/intake/upload')
  assert.equal(MAX_UPLOAD_BODY_BYTES, 20 * 1024 * 1024)
  assert.equal(MAX_UPLOAD_BODY_BYTES !== 20_000_000, true, '上限必须是 20MiB，不是 20 十进制 MB')

  assert.deepEqual([...UPLOAD_CONTENT_TYPES].sort(), [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
  ].sort())
})

// ---------------------------------------------------------------------------
//  content-type：归一 + 白名单 + 参数处理
// ---------------------------------------------------------------------------

test('normalizeContentType：小写、去掉 charset 等参数、空值 → 空串', () => {
  assert.equal(normalizeContentType('APPLICATION/PDF; charset=utf-8'), 'application/pdf')
  assert.equal(normalizeContentType('  image/PNG ; q=1'), 'image/png')
  assert.equal(normalizeContentType(undefined), '')
})

test('validateContentType：4 种允许；text/plain / multipart / octet-stream → 415', () => {
  for (const type of [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
    'APPLICATION/PDF; charset=utf-8', // 归一后应放行
  ]) {
    assert.equal(typeof validateContentType(type), 'string', `${type} 应在白名单`)
  }
  for (const type of ['text/plain', 'application/json', 'multipart/form-data; boundary=x', 'application/octet-stream', 'image/gif', undefined]) {
    assert.throws(
      () => validateContentType(type),
      (error: unknown) => {
        assert.ok(error instanceof UploadHttpProblem)
        assert.equal(error.status, 415)
        const body = error.body as { error: { code: string; reason_code: string } }
        assert.equal(body.error.code, 'UNSUPPORTED_MEDIA_TYPE')
        assert.equal(body.error.reason_code, 'UNSUPPORTED_MEDIA_TYPE')
        return true
      },
      `${String(type)} 必须被拒（415）`,
    )
  }
})

// ---------------------------------------------------------------------------
//  fileName：路径穿越 / 编码绕过 / 控制字符一律拒绝；普通名归一化
// ---------------------------------------------------------------------------

/** 非法文件名矩阵：每一条都必须抛 UploadHttpProblem(400, INVALID_FILE_NAME)。 */
const BAD_NAMES: readonly [label: string, raw: string | undefined][] = [
  ['缺失头', undefined],
  ['空串', ''],
  ['纯空白', '   '],
  ['正斜杠穿越', '../evil.pdf'],
  ['反斜杠穿越', '..\\evil.pdf'],
  ['NUL 字节', 'evil\u0000.pdf'],
  ['控制字符 LF', 'evil\n.pdf'],
  ['控制字符 CR', 'evil\r.pdf'],
  ['控制字符 TAB', 'evil\t.pdf'],
  ['百分号编码的 ../', '%2E%2E%2Fetc%20passwd.pdf'],
  ['双重编码的 ../', '%252E%252E%252Fetc.pdf'],
  ['畸形百分号编码', '%zz.pdf'],
]

for (const [label, raw] of BAD_NAMES) {
  test(`sanitizeUploadFileName 拒绝${label}: ${JSON.stringify(raw)}`, () => {
    assert.throws(
      () => sanitizeUploadFileName(raw),
      (error: unknown) => {
        assert.ok(error instanceof UploadHttpProblem, `应是 UploadHttpProblem，实际 ${String(error)}`)
        assert.equal(error.status, 400)
        const body = error.body as { error: { code: string; reason_code: string; message: string } }
        assert.equal(body.error.code, 'INVALID_ARGS')
        assert.equal(body.error.reason_code, 'INVALID_FILE_NAME')
        assert.ok(body.error.message.length > 0, '失败必须带人话原因')
        return true
      },
    )
  })
}

test('sanitizeUploadFileName 接受普通文件名并只保留安全字符（basename）', () => {
  assert.equal(sanitizeUploadFileName('resume.pdf'), 'resume.pdf')
  assert.equal(sanitizeUploadFileName('my resume (1).pdf'), 'my resume _1_.pdf')
  assert.equal(sanitizeUploadFileName('%E6%88%91%E7%9A%84%E7%AE%80%E5%8E%86.pdf'), '____.pdf')
  const safe = sanitizeUploadFileName('CV.docx')
  assert.equal(/^[A-Za-z0-9._ -]+$/.test(safe), true)
})

// ---------------------------------------------------------------------------
//  job_id：必须 query 给 UUID（缺 → MISSING_REQUIRED，非法 → ID_NOT_UUID）
// ---------------------------------------------------------------------------

test('validateJobId：缺参 400 MISSING_REQUIRED；非 UUID 400 ID_NOT_UUID；合法透传', () => {
  const JOB = '11111111-1111-4111-8111-000000000401'
  assert.equal(validateJobId(new URL(`http://localhost/x?job_id=${JOB}`), undefined), JOB)
  assert.equal(validateJobId(new URL('http://localhost/x'), JOB), JOB, 'defaultJobId 可作兜底')
  for (const [url, expectedReason] of [
    [new URL('http://localhost/x'), 'MISSING_REQUIRED'],
    [new URL('http://localhost/x?job_id=not-a-uuid'), 'ID_NOT_UUID'],
    [new URL('http://localhost/x?job_id='), 'MISSING_REQUIRED'],
  ] as const) {
    assert.throws(
      () => validateJobId(url, undefined),
      (error: unknown) => {
        assert.ok(error instanceof UploadHttpProblem)
        assert.equal(error.status, 400)
        const body = error.body as { error: { code: string; reason_code: string } }
        assert.equal(body.error.code, 'INVALID_ARGS')
        assert.equal(body.error.reason_code, expectedReason)
        return true
      },
    )
  }
})

// ---------------------------------------------------------------------------
//  validateUploadHeaders：回环 / 同源 / session 绑定三道门，失败在身份层之前
// ---------------------------------------------------------------------------

const PORT = 49347
const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_UNBOUND = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'

/** 造一个身份实例：只有 SESSION_A 绑定到 recruiter（HUMAN），其它 session 全未绑定。 */
function identity(): ReturnType<typeof createDemoActorIdentity>['identity'] {
  const made = createDemoActorIdentity()
  assert.deepEqual([...made.issues], [])
  made.identity.registry.bind(SESSION_A, 'recruiter')
  return made.identity
}

type Headers = Record<string, string | string[] | undefined>

/** 合法基线头。 */
function goodHeaders(overrides: Headers = {}): Headers {
  return {
    host: `127.0.0.1:${PORT}`,
    'x-recruitment-request': '1',
    'x-dsh-session': SESSION_A,
    'content-type': 'application/pdf',
    'x-file-name': encodeURIComponent('resume.pdf'),
    ...overrides,
  }
}

function req(headers: Headers): Pick<IncomingMessage, 'headers'> {
  return { headers }
}

function assertProblem(
  fn: () => unknown,
  status: number,
  code: string,
  reason: string,
): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof UploadHttpProblem, `应是 UploadHttpProblem，实际 ${String(error)}`)
      assert.equal(error.status, status)
      const body = error.body as { error: { code: string; reason_code: string; message: string } }
      assert.equal(body.error.code, code)
      assert.equal(body.error.reason_code, reason)
      assert.ok(body.error.message.length > 0, '失败必须带人话原因')
      return true
    },
  )
}

test('validateUploadHeaders 正常路径：session-<uuid> / 裸 uuid → HUMAN actorId', () => {
  const bound = identity()
  const bare = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  bound.registry.bind(bare, 'recruiter')
  for (const session of [SESSION_A, bare]) {
    const result = validateUploadHeaders(req(goodHeaders({ 'x-dsh-session': session })), PORT, bound)
    assert.equal(typeof result.actorId, 'string')
    assert.match(result.actorId, /^[0-9a-f-]{36}$/i)
    assert.equal(result.sessionId, `session-${session.replace(/^session-/, '').toLowerCase()}`)
  }
})

test('loopback 门：host 非 127.0.0.1/localhost:port → 403 FORBIDDEN（零身份调用）', () => {
  const unbound = identity() // 只绑 SESSION_A；若门失效会 409，证明门真的先跑
  for (const host of [
    'evil.example:49347',
    '0.0.0.0:49347',
    '192.168.1.5:49347',
    '127.0.0.1.evil.com:49347',
    '127.0.0.1:9999', // 端口不一致 → 不同源
    undefined,
  ]) {
    assertProblem(
      () => validateUploadHeaders(req(goodHeaders({ host })), PORT, unbound),
      403,
      'FORBIDDEN',
      'SAME_ORIGIN_REQUIRED',
    )
  }
  const ok = validateUploadHeaders(req(goodHeaders({ host: `localhost:${PORT}` })), PORT, unbound)
  assert.equal(typeof ok.actorId, 'string')
})

test('same-origin 门：缺 x-recruitment-request / Origin 跨源 → 403 FORBIDDEN', () => {
  const unbound = identity()
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ 'x-recruitment-request': undefined })), PORT, unbound),
    403,
    'FORBIDDEN',
    'SAME_ORIGIN_REQUIRED',
  )
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ 'x-recruitment-request': '0' })), PORT, unbound),
    403,
    'FORBIDDEN',
    'SAME_ORIGIN_REQUIRED',
  )
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ origin: 'http://evil.example' })), PORT, unbound),
    403,
    'FORBIDDEN',
    'SAME_ORIGIN_REQUIRED',
  )
  const ok = validateUploadHeaders(req(goodHeaders({ origin: `http://127.0.0.1:${PORT}` })), PORT, unbound)
  assert.equal(typeof ok.actorId, 'string')
})

test('session 门：缺失 → 400 SESSION_REQUIRED；非法 → 400 SESSION_ID_INVALID；未绑定 → 409 DEMO_ACTOR_UNMAPPED', () => {
  const bound = identity()
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ 'x-dsh-session': undefined })), PORT, bound),
    400,
    'INVALID_ARGS',
    'SESSION_REQUIRED',
  )
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ 'x-dsh-session': '' })), PORT, bound),
    400,
    'INVALID_ARGS',
    'SESSION_ID_INVALID',
  )
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ 'x-dsh-session': 'not-a-session' })), PORT, bound),
    400,
    'INVALID_ARGS',
    'SESSION_ID_INVALID',
  )
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ 'x-dsh-session': SESSION_UNBOUND })), PORT, bound),
    409,
    'DEMO_ACTOR_UNMAPPED',
    'DEMO_ACTOR_UNMAPPED',
  )
})

test('fail-closed 汇总：按 handler 的闸门顺序逐项拒绝，拒绝码互不串味', () => {
  const bound = identity()

  // 前两道门在 validateUploadHeaders 内（回环 + session）。
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ host: 'evil.example:49347' })), PORT, bound),
    403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED',
  )
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ 'x-recruitment-request': undefined })), PORT, bound),
    403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED',
  )
  assertProblem(
    () => validateUploadHeaders(req(goodHeaders({ 'x-dsh-session': SESSION_UNBOUND })), PORT, bound),
    409, 'DEMO_ACTOR_UNMAPPED', 'DEMO_ACTOR_UNMAPPED',
  )

  // 后两道门是独立纯函数；handler 按同样顺序调用，全部在 readRawBody/createIntakeUploadTask 之前。
  const base = goodHeaders()
  assert.doesNotThrow(() => validateUploadHeaders(req(base), PORT, bound), '基线头必须通过身份门')
  assertProblem(
    () => validateContentType('text/plain'),
    415, 'UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE',
  )
  assertProblem(
    () => sanitizeUploadFileName('../evil.pdf'),
    400, 'INVALID_ARGS', 'INVALID_FILE_NAME',
  )
})
