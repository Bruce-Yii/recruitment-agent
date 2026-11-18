// 简历上传的 DB + 文件系统落地层（owner-upload-async / ia-db lane）。
//
// 职责边界（只做这一件事）：
//   1. 把调用方（HTTP 层）已经收好的原始字节落到 converter.allowed_roots[0]/.intake/<id>/；
//   2. 从**磁盘读回**字节复算 sha256，与内存 sha256 比对（不一致 fail-closed 并清理）；
//   3. 在一个 withActor 事务里写 event_inbox（形状与 application-intake.ts::upsertIntakeEvent
//      逐字一致，normalizer_version='intake/1.0.0'）+ 建一条可被 tick loop 认领的
//      RESUME_PARSE business_task。不新建队列、不改 router/工具文件。
//
// 为什么要落 allowed_roots[0]/.intake 而不是 os.tmpdir()：
//   邮件编排层踩过的坑（connectors/mail/orchestrator.ts::resolveTempRoot）：temp 目录不在
//   allowed_roots 内 → 后续 reader 判 OUTSIDE_ALLOWED_ROOTS 而拒绝读。默认落在允许根内，
//   天然满足「落点 → 读取」两端一致的约束。
//
// 幂等口径：
//   * event_inbox 幂等键 `resume.intake:<sha256>`（与工具完全同形）；
//   * business_task 幂等键 `task:RESUME_PARSE:INTAKE_RECORD:<sha256>`。
//     真实 router 的键是 `task:RESUME_PARSE:INTAKE_RECORD:<intake_record_id>`，但上传阶段
//     还没有 intake_record（解析/入库在后续 tool 完成）。这里用同一命名空间的稳定内容键，
//     既保证同一份文件重复上传不会建两个任务，又让 tick loop 以 PENDING + next_run_at<=now
//     直接认领（claim.ts::claimNextTask 只看这些列 + business_refs 数组）。
//   * 后续 router 若对同一事件再建一个以 intake_record_id 为键的任务，那是不同键、互不覆盖；
//     本层不负责合并（合并语义属于解析工具，超出本 lane 边界）。
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath, isAbsolute, relative } from 'node:path'

import { isUuidText } from './pool.ts'
import { EVENT_TYPES } from '../runtime/event-types.ts'

export const INTAKE_UPLOAD_PATH = '/recruitment/api/intake/upload'
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const INTAKE_UPLOAD_CONTENT_TYPES: readonly string[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
]

export interface IntakeUploadInput {
  readonly bytes: Buffer
  readonly contentType: string
  readonly fileName: string
  readonly tenantId: string
  readonly actorId: string
  readonly jobId: string
}

export type IntakeUploadFailureCode =
  | 'NOT_CONFIGURED' | 'UNSUPPORTED_MEDIA_TYPE' | 'FILE_TOO_LARGE'
  | 'INVALID_FILE_NAME' | 'OUTSIDE_ALLOWED_ROOTS' | 'SHA256_MISMATCH'
  | 'DB_ERROR' | 'WRITE_IDENTITY_REQUIRED'

export interface IntakeUploadFailure {
  readonly ok: false
  readonly code: IntakeUploadFailureCode
  readonly reason: string
}

export interface IntakeUploadSuccess {
  readonly ok: true
  readonly task_id: string
  readonly status: 'RUNNING'
  readonly event_id: string
  readonly material_path: string
  readonly sha256: string
  readonly byte_size: number
  readonly file_name: string
}

export type IntakeUploadResult = IntakeUploadSuccess | IntakeUploadFailure

export interface IntakeUploadDeps {
  readonly database: import('../db/pool.ts').ResolvedDatabaseConfig | null
  readonly converter: { readonly allowed_roots: readonly string[] }
}

/** The event type string, imported from the authoritative registry. */
const RESUME_INTAKE_EVENT_TYPE = EVENT_TYPES.RESUME_INTAKE_RECEIVED

/** Fail result helper (keeps every reason Chinese + human-readable). */
function fail(code: IntakeUploadFailureCode, reason: string): IntakeUploadFailure {
  return { ok: false, code, reason }
}

/**
 * 文件名校验：拒绝任何路径成分与危险字符（不「尽量 strip」，直接整名拒绝）。
 * 规则沿用 orchestrator / worker-material-landing：不允许 `\\` `/` `..` NUL 控制字符，
 * 解码后长度 ≤ 200。
 */
function isInvalidFileName(fileName: string): boolean {
  if (typeof fileName !== 'string') return true
  if (fileName.length === 0 || fileName.length > 200) return true
  // eslint-disable-next-line no-control-regex -- 明确拒绝 NUL 与 C0/C1 控制字符
  if (/[\u0000-\u001f\u007f-\u009f]/.test(fileName)) return true
  if (fileName.includes('\\') || fileName.includes('/')) return true
  if (fileName.includes('..')) return true
  if (fileName === '.' || fileName.trim() === '') return true
  // 双重 URL 编码穿越（%252E%252E%252F → 解码两次后是 ../）在字面检查里
  // 没有 `../`，但下游若连续解码两次就会变成路径成分。逐次解码最多两次，
  // 命中路径分隔符 / `..` / NUL 一律整名拒绝（fail-closed，不 strip）。
  // decodeURIComponent 遇到非法 `%` 序列会抛，提前结束解码链即可。
  let decoded = fileName
  for (let i = 0; i < 2; i += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      break // 非法百分号编码：不是编码串，交由上面的字面检查判定即可
    }
    if (next === decoded) break // 没有进一步解码，停止
    decoded = next
    // eslint-disable-next-line no-control-regex -- 明确拒绝 NUL 与 C0/C1 控制字符
    if (/[\u0000-\u001f\u007f-\u009f]/.test(decoded)) return true
    if (decoded.includes('\\') || decoded.includes('/')) return true
    if (decoded.includes('..')) return true
  }
  return false
}

/** 把已通过校验的文件名收敛成「只含安全字符」的短 basename。 */
function sanitizeFileName(fileName: string, idHex: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return `resume-${idHex}-${safe || 'resume'}`
}

/**
 * 严格的「candidate 在 root 内」判断（realpath 之后调用，避免符号链接越界）。
 * root 自身不算 inside（文件上传必须落在子路径）。
 */
function isInsideRoot(candidate: string, root: string): boolean {
  const base = resolvePath(root)
  const abs = resolvePath(candidate)
  const rel = relative(base, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 所有 allowed_roots 都必须包含的 strict-inside 校验。 */
function isInsideEveryRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.length > 0 && roots.every((root) => isInsideRoot(candidate, root))
}

/** 从磁盘读回复算 sha256（小写 hex）。 */
async function sha256OfFile(filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 主入口：落盘 + 复算 sha256 + 单事务写 event_inbox / business_task。
 *
 * 失败顺序是刻意的：先做所有「零写入」的纯校验，再做文件系统写，最后才开 DB 事务。
 * 任何一步失败都不会留下半截任务。
 */
export async function createIntakeUploadTask(
  deps: IntakeUploadDeps,
  input: IntakeUploadInput,
): Promise<IntakeUploadResult> {
  // ── 1. 零写入的 fail-fast 校验 ────────────────────────────────
  if (deps.database === null) {
    return fail('NOT_CONFIGURED', '数据库未配置，无法接收简历上传')
  }
  if (!INTAKE_UPLOAD_CONTENT_TYPES.includes(input.contentType)) {
    return fail('UNSUPPORTED_MEDIA_TYPE', `不支持的文件类型：${input.contentType}（仅支持 PDF / DOCX / PNG / JPEG）`)
  }
  if (!Buffer.isBuffer(input.bytes)) {
    return fail('UNSUPPORTED_MEDIA_TYPE', '上传内容不是有效的字节流')
  }
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    return fail('FILE_TOO_LARGE', `文件超过 ${MAX_UPLOAD_BYTES} 字节上限（当前 ${input.bytes.length} 字节）`)
  }
  if (isInvalidFileName(input.fileName)) {
    return fail('INVALID_FILE_NAME', '文件名不合法：不能为空、不能包含路径分隔符/../控制字符，且长度不超过 200')
  }
  // 写身份必须是真实 UUID；HTTP 层从 x-dsh-session 解析真人 actor 后传入。
  // tenant_id / job_id 也走 uuid 绑定，非法早拒，避免 pg 抛 22P02 被误报成 DB_ERROR。
  if (!isUuidText(input.actorId) || !isUuidText(input.tenantId) || !isUuidText(input.jobId)) {
    return fail('WRITE_IDENTITY_REQUIRED', '写入身份或租户/岗位标识不合法（需要有效的 UUID）')
  }

  const roots = deps.converter.allowed_roots
  if (roots.length === 0) {
    return fail('OUTSIDE_ALLOWED_ROOTS', '未配置允许根目录（allowed_roots 为空），拒绝写入')
  }
  // allowed_roots 里的每一项都必须是绝对路径；否则 node:path 的 resolve 会按 cwd 猜，fail-closed。
  if (roots.some((root) => !isAbsolute(root))) {
    return fail('OUTSIDE_ALLOWED_ROOTS', '允许根目录必须是绝对路径，拒绝写入')
  }

  // ── 2. 落盘（allowed_roots[0]/.intake/<id>/）────────────────────
  const idHex = randomBytes(8).toString('hex')
  const base = resolvePath(roots[0]!)
  const dir = join(base, '.intake', idHex)
  if (!isInsideEveryRoot(dir, roots)) {
    return fail('OUTSIDE_ALLOWED_ROOTS', '落地目录越出允许根目录，拒绝写入')
  }

  let materialPath = ''
  let safeName = ''
  try {
    await mkdir(dir, { recursive: true })
    const realDir = await realpath(dir)
    if (!isInsideEveryRoot(realDir, roots)) {
      return fail('OUTSIDE_ALLOWED_ROOTS', '落地目录的 realpath 越出允许根目录，拒绝写入')
    }

    safeName = sanitizeFileName(input.fileName, idHex)
    materialPath = join(realDir, safeName)
    if (!isInsideEveryRoot(materialPath, roots)) {
      return fail('OUTSIDE_ALLOWED_ROOTS', '落地文件的 realpath 越出允许根目录，拒绝写入')
    }
    // 'wx'：同名文件已存在就失败，绝不覆盖（随机 id 下几乎不会发生，但守住语义）。
    await writeFile(materialPath, input.bytes, { flag: 'wx' })
    const realFile = await realpath(materialPath)
    if (!isInsideEveryRoot(realFile, roots)) {
      await rm(materialPath, { force: true }).catch(() => undefined)
      return fail('OUTSIDE_ALLOWED_ROOTS', '落地文件的 realpath 越出允许根目录，已清理')
    }
    materialPath = realFile
  } catch (error) {
    if (materialPath !== '') await rm(materialPath, { force: true }).catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return fail('OUTSIDE_ALLOWED_ROOTS', `文件无法在允许根目录内落地：${error instanceof Error ? error.message : String(error)}`)
  }

  // ── 3. 从磁盘复算 sha256（不一致 fail-closed，删除文件）──────────
  let sha256: string
  try {
    sha256 = await sha256OfFile(materialPath)
  } catch (error) {
    await rm(materialPath, { force: true }).catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return fail('SHA256_MISMATCH', `无法从磁盘读回文件以复算 sha256：${error instanceof Error ? error.message : String(error)}`)
  }
  const expectedSha256 = createHash('sha256').update(input.bytes).digest('hex')
  if (sha256 !== expectedSha256) {
    await rm(materialPath, { force: true }).catch(() => undefined)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    return fail('SHA256_MISMATCH', '磁盘字节复算 sha256 与内存不一致，已清理文件，拒绝建任务')
  }

  // ── 4. 单事务：event_inbox + business_task ─────────────────────
  const { createPool, withActor, closePool } = await import('./pool.ts')
  const pool = createPool(deps.database)
  try {
    const result = await withActor(pool, input.actorId, async (client) => {
      // 4a) 事件行：与 application-intake.ts::upsertIntakeEvent 逐字同形。
      const eventIdempotencyKey = `resume.intake:${sha256}`
      const inserted = await client.query<{ event_id: string }>(
        `insert into recruitment.event_inbox
           (tenant_id, provider, event_type, schema_version, occurred_at, received_at, recorded_at,
            idempotency_key, idempotency_source, source_object_id, payload, trust_level,
            normalized_event_type, normalizer_version)
         values ($1, 'internal', $5, 1, now(), now(), now(),
                 $2, 'FALLBACK_KEY', $3, $4::jsonb, 'INTERNAL', $5, 'intake/1.0.0')
         on conflict (tenant_id, idempotency_key) do nothing
         returning event_id::text as event_id`,
        [
          input.tenantId,
          eventIdempotencyKey,
          sha256,
          JSON.stringify({
            sha256,
            file_name: input.fileName,
            pages: 0,
            source_kind: 'LOCAL_FILE',
          }),
          RESUME_INTAKE_EVENT_TYPE,
        ],
      )
      let eventId = inserted.rows[0]?.event_id
      if (eventId === undefined) {
        const found = await client.query<{ event_id: string }>(
          'select event_id::text as event_id from recruitment.event_inbox where tenant_id = $1 and idempotency_key = $2',
          [input.tenantId, eventIdempotencyKey],
        )
        eventId = found.rows[0]?.event_id
      }
      if (eventId === undefined) throw new Error('event_inbox row vanished during upload intake')

      // 4b) 业务任务：与 createOrWakeTask 的同名列/同命名空间的稳定键（见文件头说明）。
      const taskKey = `task:RESUME_PARSE:INTAKE_RECORD:${sha256}`
      const taskInsert = await client.query<{ id: string }>(
        `insert into recruitment.business_task (
             tenant_id, task_type, business_refs, title, description, priority,
             trigger_event_id, created_by_actor_id, idempotency_key, status, next_run_at
           ) values (
             $1::uuid, $2, $3::jsonb, $4, $5, $6,
             $7::uuid, $8::uuid, $9, $10, now()
           )
           on conflict (tenant_id, idempotency_key) do nothing
           returning id::text`,
        [
          input.tenantId,
          'RESUME_PARSE',
          JSON.stringify([{ kind: 'INTAKE_RECORD', id: sha256, job_id: input.jobId, material_path: materialPath }]),
          '解析新收到的简历',
          `uploaded resume intake (event ${eventId})`,
          3,
          eventId,
          input.actorId,
          taskKey,
          'PENDING',
        ],
      )
      let taskId = taskInsert.rows[0]?.id
      if (taskId === undefined) {
        const raced = await client.query<{ id: string }>(
          'select id::text from recruitment.business_task where tenant_id = $1::uuid and idempotency_key = $2',
          [input.tenantId, taskKey],
        )
        taskId = raced.rows[0]?.id
      }
      if (taskId === undefined) throw new Error('business_task row vanished during upload intake')

      return { taskId, eventId }
    })

    return {
      ok: true,
      task_id: result.taskId,
      status: 'RUNNING',
      event_id: result.eventId,
      material_path: materialPath,
      sha256,
      byte_size: input.bytes.length,
      file_name: safeName,
    }
  } catch (error) {
    return fail('DB_ERROR', `写库失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await closePool(pool).catch(() => undefined)
  }
}
