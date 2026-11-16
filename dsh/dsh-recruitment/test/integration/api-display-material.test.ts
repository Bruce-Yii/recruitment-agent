// D5 展示层 · 原件受控获取端点（`GET|HEAD /recruitment/api/material/<id>/content`）的
// **真库 + 真 HTTP** 集成测试（owner-api-display / A-material）。
//
// 唯一权威口径：`work/d5/api-display/CONTRACT.md` §0 / §1 / §4。纪律（照 job-close-action.test.ts）：
//   1. 本文件独占一个 `createIsolatedTestDatabase('disp_mat')` 一次性空库（迁移 0001→0016 重放）；
//      **不写** `ra_s6s7`；`assertPrivateDatabase` 守卫；`after` 里 `db.drop()`；
//   2. 连不上库就**失败**（不静默 skip：R3 要求 skipped === 0）；
//   3. 真 `node:http` `listen(0, '127.0.0.1')` + 真 `fetch`；假 `webServer.register` 收集 prefix 路由
//      并按 pathname 分发（**不打桩 handler**，请求真的进 `registerMaterialContentHttp`）；
//   4. 断言只信**独立 SQL 读回**（本文件只 import 被测路由模块与纯函数，不用产品代码自证）；
//      每条用例（含 200）都断言零写入：intake_asset / resume / resume_version / application 行数前后全等；
//   5. 原件用 `os.tmpdir()` + `mkdtemp` 建的临时 allowed root 里的**真实字节**（含 PDF 魔数即可，
//      不是真 PDF）；sha256 / byte_size 与库行严格一致；通过 `deps.roots` 注入，**不依赖本机 env**。
//
// 覆盖（CONTRACT §1 + 任务书）：200 全文（字节全等）、Range 206（闭区间/开区间/后缀）、416、
// HEAD、404 家族（不存在 / 跨租户 / 未绑定简历 / 根外 / sha 不符 / 符号链接候选）、403 家族
// （application 不匹配 / resume_version 不匹配 / 缺同源头 / Host 非法 / 跨源 Origin）、400（非法 id /
// 未知参数 / 路径穿越 / 覆盖身份）、405（POST）、503（未配置）、非法 mime 回退 + 中文文件名 RFC5987、
// 响应与 header 不含本机绝对路径、纯函数边界（parseByteRange / contentDispositionInline / contentTypeFor）。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MATERIAL_CONTENT_CONTRACT_VERSION,
  MATERIAL_CONTENT_ROUTE_PREFIX,
  contentDispositionInline,
  contentTypeFor,
  parseByteRange,
  parseMaterialContentPath,
  registerMaterialContentHttp,
  type MaterialContentDeps,
} from '../../src/http/material-content.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  hex64,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

// ---------------------------------------------------------------------------
//  固定 id（本文件独占的一次性库；UUID 形状合法即可）
// ---------------------------------------------------------------------------

/** 演示部门（0002_seed …010）。 */
const DEMO_DEPARTMENT = '11111111-1111-4111-8111-000000000010'
/** 演示 HR 专员（0002_seed …103）。 */
const ACTOR_103 = '11111111-1111-4111-8111-000000000103'
/** 跨租户反证组织（本文件自建；主租户来自 0002_seed）。 */
const OTHER_TENANT = 'eeeeeeee-0000-4000-8000-000000000001'

/**
 * 本文件专用的 UUID 生成器（一次性库，形状合法即可）。
 * @param kind - 对象族（1 job / 2 job_version / 3 intake_record / 4 intake_asset / 5 resume /
 *   6 resume_version / 7 application / 8 candidate）。
 * @param n - 同族序号。
 */
function fid(kind: number, n: number): string {
  const group1 = (0xdd000000 + kind * 0x1000 + n).toString(16).padStart(8, '0')
  return `${group1}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

const JOB = fid(1, 1)
const JOB_VERSION = fid(2, 1)

/** 材料夹具的"逻辑键"（每个键对应 1 条 asset + 可选 resume/resume_version/application 链）。 */
type FixtureKey = 'ok' | 'mismatch' | 'unbound' | 'outside' | 'forged' | 'linked' | 'otherTenant' | 'weirdMime'
const FIXTURE_KEYS: readonly FixtureKey[] = ['ok', 'mismatch', 'unbound', 'outside', 'forged', 'linked', 'otherTenant', 'weirdMime']

/** 每个夹具的行 id（asset 族固定序号 = 键顺序 + 1）。 */
const IDS = Object.fromEntries(FIXTURE_KEYS.map((key, index) => [key, {
  assetId: fid(4, index + 1),
  intakeRecordId: fid(3, index + 1),
  resumeId: fid(5, index + 1),
  resumeVersionId: fid(6, index + 1),
  applicationId: fid(7, index + 1),
  candidateId: fid(8, index + 1),
}])) as Record<FixtureKey, {
  assetId: string
  intakeRecordId: string
  resumeId: string
  resumeVersionId: string
  applicationId: string
  candidateId: string
}>

/** 库里写的文件名（= 磁盘上的真实文件名；文件名与字节都不含路径）。 */
const FILE_NAME: Record<FixtureKey, string> = {
  ok: 'resume-alpha.pdf',
  mismatch: 'resume-beta.pdf',
  unbound: 'resume-unbound.pdf',
  outside: 'resume-outside.pdf',
  forged: 'resume-forged.pdf',
  linked: 'resume-linked.pdf',
  otherTenant: 'resume-other-tenant.pdf',
  // 非 ASCII + 空格：验证 content-disposition 的 RFC5987 与 ASCII fallback。
  weirdMime: '简历 原件.pdf',
}

/** 集成测试底座配置（密码只从环境变量来；缺了 `testDatabaseConfig()` 直接抛 = 失败，不 skip）。 */
const BASE = testDatabaseConfig()

// ---------------------------------------------------------------------------
//  一次性库 + 夹具
// ---------------------------------------------------------------------------

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let server: MaterialServer

/** 临时目录（allowed root / 根外目录 / 链接目标目录）。 */
let tmpBase = ''
let rootDir = ''
let outsideDir = ''
let linkTargetDir = ''
/** 链接候选的形态（Windows 无开发者模式时是 junction；两者都被 lstat/dirent 报为符号链接）。 */
let linkKind = ''

/** 所有材料的真实字节（磁盘上的内容）；DB 行必须与其中对应项的 sha256/byte_size 严格一致。 */
interface FilePlan {
  readonly ok: Buffer
  readonly mismatch: Buffer
  readonly unbound: Buffer
  readonly outside: Buffer
  /** 磁盘上的字节（与 DB 记录的 sha 不同，长度相同）。 */
  readonly forgedOnDisk: Buffer
  /** "库里声称"的字节（只用于算出 sha/byte_size，绝不落盘）。 */
  readonly forgedInDb: Buffer
  readonly linked: Buffer
  readonly otherTenant: Buffer
  readonly weirdMime: Buffer
}

/** 造一段确定性字节：PDF 魔数开头（不必是真 PDF），后面是确定性填充。 */
function pdfBytes(label: string, size: number): Buffer {
  const head = Buffer.from(`%PDF-1.7\n% d5-material fixture: ${label}\n`, 'latin1')
  if (size <= head.length + 8) throw new Error(`fixture size too small for ${label}: ${size}`)
  const body = Buffer.alloc(size - head.length)
  for (let i = 0; i < body.length; i += 1) body[i] = 0x41 + ((i * 7 + label.length * 3) % 26)
  return Buffer.concat([head, body])
}

/** 生成全部夹具字节；`forgedInDb` 由 `forgedOnDisk` 改一个字节得到（长度相同 → 只有 sha 不符）。 */
function buildFilePlan(): FilePlan {
  const forgedOnDisk = pdfBytes('forged-on-disk', 1200)
  const forgedInDb = Buffer.from(forgedOnDisk)
  forgedInDb[600] = forgedInDb[600]! ^ 0xff
  return {
    ok: pdfBytes('alpha', 4096),
    mismatch: pdfBytes('beta', 2048),
    unbound: pdfBytes('unbound', 1024),
    outside: pdfBytes('outside', 1500),
    forgedOnDisk,
    forgedInDb,
    linked: pdfBytes('linked', 1300),
    otherTenant: pdfBytes('other-tenant', 1400),
    weirdMime: pdfBytes('weird-mime', 1100),
  }
}

/** 文件字节的 sha256（小写 hex）。 */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 独立的 SQL 读回（连本用例的一次性库；不经过任何产品模块）。 */
async function query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 跑一条 returning 单列的 insert 并取回值（夹具专用）。 */
async function one(sql: string, params: readonly unknown[]): Promise<string> {
  const rows = await query<Record<string, string>>(sql, params)
  const value = rows[0] === undefined ? undefined : Object.values(rows[0])[0]
  if (typeof value !== 'string') throw new Error(`no string row returned by: ${sql.slice(0, 60)}`)
  return value
}

/** 写磁盘夹具：allowed root / 根外目录 / 链接目标目录；链接候选在 root 里命名成"原件名"。 */
function writeFixtureFiles(files: FilePlan): void {
  writeFileSync(join(rootDir, FILE_NAME.ok), files.ok)
  writeFileSync(join(rootDir, FILE_NAME.mismatch), files.mismatch)
  writeFileSync(join(rootDir, FILE_NAME.unbound), files.unbound)
  writeFileSync(join(rootDir, FILE_NAME.forged), files.forgedOnDisk)
  writeFileSync(join(rootDir, FILE_NAME.weirdMime), files.weirdMime)
  // 跨租户反证：文件**在**允许根里（若漏了 tenant 过滤，就会 200 而不是 404）。
  writeFileSync(join(rootDir, FILE_NAME.otherTenant), files.otherTenant)
  // 根外反证：同名同 sha 的真件在允许根之外。
  writeFileSync(join(outsideDir, FILE_NAME.outside), files.outside)
  // 符号链接反证：真件在链接目标目录里，root 里只有指向它的重解析点。
  writeFileSync(join(linkTargetDir, FILE_NAME.linked), files.linked)

  // 优先真实符号链接；Windows 无开发者模式时 `symlinkSync(...,'file')` 会 EPERM，
  // 退化成 junction（目录重解析点，lstat/dirent 同样报告为符号链接）——反证同一段代码路径。
  const linkPath = join(rootDir, FILE_NAME.linked)
  try {
    symlinkSync(join(linkTargetDir, FILE_NAME.linked), linkPath, 'file')
    linkKind = 'file-symlink'
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS') throw error
    symlinkSync(linkTargetDir, linkPath, 'junction')
    linkKind = 'junction'
  }
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true, '夹具：root 里必须存在一个符号链接形态的候选')
}

/**
 * 夹具行（一次性库；全部由本文件用 SQL 自建）：
 *   job + job_version + 3 候选人 + 8 份材料链。
 * 每份材料：event_inbox → intake_record → intake_asset（+ 可选 resume → resume_version → application）。
 */
async function seedFixture(files: FilePlan): Promise<void> {
  await query(
    `insert into recruitment.organization (id, name, timezone)
     values ($1, '跨租户反证组织（一次性库）', 'Asia/Shanghai')`,
    [OTHER_TENANT],
  )
  await query(
    `insert into recruitment.job (id, tenant_id, department_id, code, title, status)
     values ($1,$2,$3,'D5MAT-001','材料展示测试岗位（一次性库）','OPEN')`,
    [JOB, TENANT, DEMO_DEPARTMENT],
  )
  await query(
    `insert into recruitment.job_version
       (id, tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
     values ($1,$2,$3,1,'材料展示测试 JD',$4,$5)`,
    [JOB_VERSION, TENANT, JOB, hex64('d5mat-jv-1'), ACTOR_103],
  )
  // 每个 ACTIVE 申请一个独立候选人（避开 uq_application_active_cycle）。
  await query(
    `insert into recruitment.candidate (id, tenant_id, display_name, identity_status) values
       ($1,$4,'材料测试候选人-A','ACTIVE'), ($2,$4,'材料测试候选人-B','ACTIVE'), ($3,$4,'材料测试候选人-C','ACTIVE')`,
    [IDS.ok.candidateId, IDS.mismatch.candidateId, IDS.outside.candidateId, TENANT],
  )

  /** 一条材料链的完整事实（sha/byte_size 由"库里声称的字节"决定）。 */
  interface Chain {
    readonly key: FixtureKey
    readonly tenantId: string
    readonly fileName: string
    readonly mimeType: string | null
    readonly claimedBytes: Buffer
    readonly bindResume: boolean
    readonly bindResumeVersion: boolean
    readonly bindApplication: boolean
    readonly candidateId: string | null
  }

  const chains: readonly Chain[] = [
    { key: 'ok', tenantId: TENANT, fileName: FILE_NAME.ok, mimeType: 'application/pdf', claimedBytes: files.ok, bindResume: true, bindResumeVersion: true, bindApplication: true, candidateId: IDS.ok.candidateId },
    { key: 'mismatch', tenantId: TENANT, fileName: FILE_NAME.mismatch, mimeType: 'application/pdf', claimedBytes: files.mismatch, bindResume: true, bindResumeVersion: true, bindApplication: true, candidateId: IDS.mismatch.candidateId },
    // 未绑定简历：asset 存在、链上没有任何 resume → 404 MATERIAL_ORIGINAL_UNBOUND（文件真的在 root 里）。
    { key: 'unbound', tenantId: TENANT, fileName: FILE_NAME.unbound, mimeType: 'application/pdf', claimedBytes: files.unbound, bindResume: false, bindResumeVersion: false, bindApplication: false, candidateId: null },
    { key: 'outside', tenantId: TENANT, fileName: FILE_NAME.outside, mimeType: 'application/pdf', claimedBytes: files.outside, bindResume: true, bindResumeVersion: true, bindApplication: true, candidateId: IDS.outside.candidateId },
    // sha 不符：库里的 sha 是 forgedInDb 的（磁盘上是 forgedOnDisk，字节数相同 → 预筛能命中、sha 确认失败）。
    { key: 'forged', tenantId: TENANT, fileName: FILE_NAME.forged, mimeType: 'application/pdf', claimedBytes: files.forgedInDb, bindResume: true, bindResumeVersion: false, bindApplication: false, candidateId: null },
    // 符号链接候选：root 里只有指向根外的重解析点。
    { key: 'linked', tenantId: TENANT, fileName: FILE_NAME.linked, mimeType: 'application/pdf', claimedBytes: files.linked, bindResume: true, bindResumeVersion: false, bindApplication: false, candidateId: null },
    // 跨租户：asset 属于另一个租户（文件真的在 root 里），主租户查询必须 404 且不区分。
    { key: 'otherTenant', tenantId: OTHER_TENANT, fileName: FILE_NAME.otherTenant, mimeType: 'application/pdf', claimedBytes: files.otherTenant, bindResume: true, bindResumeVersion: false, bindApplication: false, candidateId: null },
    // 非法 mime（CRLF 注入尝试）+ 非 ASCII 文件名：content-type 必须回退 octet-stream。
    { key: 'weirdMime', tenantId: TENANT, fileName: FILE_NAME.weirdMime, mimeType: 'application/pdf\r\nx-injected: 1', claimedBytes: files.weirdMime, bindResume: true, bindResumeVersion: false, bindApplication: false, candidateId: null },
  ]

  for (const chain of chains) {
    const ids = IDS[chain.key]
    const sha256 = sha256Hex(chain.claimedBytes)
    const eventId = await one(
      `insert into recruitment.event_inbox (tenant_id, provider, event_type, idempotency_key, payload, trust_level)
       values ($1,'internal','test.d5-material.seed',$2,'{}'::jsonb,'INTERNAL') returning event_id`,
      [chain.tenantId, `d5-mat:${chain.key}`],
    )
    await query(
      `insert into recruitment.intake_record (id, tenant_id, event_id, subject, status)
       values ($1,$2,$3,$4,'RESOLVED')`,
      [ids.intakeRecordId, chain.tenantId, eventId, `材料展示测试收件（${chain.key}）`],
    )
    await query(
      `insert into recruitment.intake_asset
         (id, tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref, validation_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'VALID')`,
      [
        ids.assetId,
        chain.tenantId,
        ids.intakeRecordId,
        chain.fileName,
        chain.mimeType,
        chain.claimedBytes.length,
        sha256,
        // 库里真实形态：content-addressed 引用，**没有路径**。
        `content-addressed:sha256:${sha256}`,
      ],
    )
    if (!chain.bindResume) continue
    await query(
      `insert into recruitment.resume (id, tenant_id, candidate_id, intake_asset_id)
       values ($1,$2,$3,$4)`,
      [ids.resumeId, chain.tenantId, chain.candidateId, ids.assetId],
    )
    if (!chain.bindResumeVersion) continue
    await query(
      `insert into recruitment.resume_version
         (id, tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
          parser_name, parser_version, parse_status, parsed_fields, evidence)
       values ($1,$2,$3,1,$4,$5,'pymupdf','1.0.0','PARSED','{}'::jsonb,'[]'::jsonb)`,
      [ids.resumeVersionId, chain.tenantId, ids.resumeId, sha256, hex64(`content:${chain.key}`)],
    )
    if (!chain.bindApplication) continue
    await query(
      `insert into recruitment.application
         (id, tenant_id, candidate_id, job_id, job_version_id, resume_version_id,
          lifecycle_status, current_stage_code)
       values ($1,$2,$3,$4,$5,$6,'ACTIVE','S7')`,
      [ids.applicationId, chain.tenantId, chain.candidateId, JOB, JOB_VERSION, ids.resumeVersionId],
    )
  }
}

/** 夹具完整性自检：只断言本用例真正依赖的行（不拿"迁移跑通"当证据）。 */
async function assertFixtureIntegrity(files: FilePlan): Promise<void> {
  const assets = await query<{ id: string; file_name: string; byte_size: string; sha256: string; storage_ref: string }>(
    `select id::text as id, file_name, byte_size, sha256, storage_ref
       from recruitment.intake_asset order by file_name`,
  )
  assert.equal(assets.length, FIXTURE_KEYS.length, '夹具：八份材料')
  const byFileName = new Map(assets.map((asset) => [asset.file_name, asset]))
  for (const asset of assets) {
    // 库里**没有路径**：storage_ref 只有 content-addressed:sha256:<sha>（这正是本端点的存在理由）。
    assert.match(asset.storage_ref, /^content-addressed:sha256:[0-9a-f]{64}$/, '夹具：storage_ref 不能含路径')
  }
  const counts = await query<Record<string, number>>(
    `select (select count(*)::int from recruitment.resume)          as resume_rows,
            (select count(*)::int from recruitment.resume_version)  as resume_version_rows,
            (select count(*)::int from recruitment.application)     as application_rows`,
  )
  // 1 条 application 来自 0002_seed（演示申请），另外 3 条是本文件的夹具链
  // （ok / mismatch / outside）；resume 与 resume_version 全部来自夹具。
  assert.deepEqual(counts[0], { resume_rows: 7, resume_version_rows: 3, application_rows: 4 }, '夹具：链数量（seed 1 + 夹具 3）')

  /** 磁盘上应该与库行严格一致的文件（forged 除外：它就是"故意不一致"的反证）。 */
  const consistent: { key: FixtureKey; bytes: Buffer; path: string }[] = [
    { key: 'ok', bytes: files.ok, path: join(rootDir, FILE_NAME.ok) },
    { key: 'mismatch', bytes: files.mismatch, path: join(rootDir, FILE_NAME.mismatch) },
    { key: 'unbound', bytes: files.unbound, path: join(rootDir, FILE_NAME.unbound) },
    { key: 'otherTenant', bytes: files.otherTenant, path: join(rootDir, FILE_NAME.otherTenant) },
    { key: 'weirdMime', bytes: files.weirdMime, path: join(rootDir, FILE_NAME.weirdMime) },
  ]
  for (const item of consistent) {
    const disk = readFileSync(item.path)
    const row = byFileName.get(FILE_NAME[item.key])
    assert.ok(row !== undefined, `夹具：库里必须有 ${FILE_NAME[item.key]} 这一行`)
    assert.deepEqual(disk, item.bytes, `夹具：${item.key} 磁盘字节必须等于计划字节`)
    assert.equal(sha256Hex(disk), row.sha256, `夹具：${item.key} 磁盘 sha256 必须与库行严格一致`)
    assert.equal(disk.length, Number(row.byte_size), `夹具：${item.key} byte_size 必须与库行严格一致`)
  }

  // forged：磁盘字节与库里的 sha **故意不同**（同字节数 → 预筛能命中、sha 确认必须失败）。
  const forgedDisk = readFileSync(join(rootDir, FILE_NAME.forged))
  const forgedRow = byFileName.get(FILE_NAME.forged)
  assert.ok(forgedRow !== undefined, '夹具：库里必须有 forged 这一行')
  assert.equal(forgedDisk.length, Number(forgedRow.byte_size), '夹具：forged 磁盘与库的字节数相同（只有 sha 不同）')
  assert.notEqual(sha256Hex(forgedDisk), forgedRow.sha256, '夹具：forged 的磁盘 sha 必须与库行不同')
  assert.equal(forgedRow.sha256, sha256Hex(files.forgedInDb), '夹具：forged 库行的 sha 来自"未落盘"的字节')

  assert.equal(existsSync(join(outsideDir, FILE_NAME.outside)), true, '夹具：根外真件存在')
  assert.equal(existsSync(join(linkTargetDir, FILE_NAME.linked)), true, '夹具：链接目标真件存在')
  assert.equal(existsSync(join(rootDir, FILE_NAME.outside)), false, '夹具：根外真件不得出现在允许根里')
}

// ---------------------------------------------------------------------------
//  before / after
// ---------------------------------------------------------------------------

before(async () => {
  db = await createIsolatedTestDatabase('disp_mat')
  assertPrivateDatabase(db.name)
  // 一次性库名必须形如 ra_disp_…（CONTRACT §4），且绝不是共享库。
  assert.match(db.name, /^ra_disp_/)
  assert.ok(db.migrations.length >= 16, `一次性库必须重放 0001→0016（实际 ${db.migrations.length}）`)
  cfg = { ...BASE, database: db.name }

  tmpBase = mkdtempSync(join(tmpdir(), 'dsh-d5-material-'))
  rootDir = join(tmpBase, 'allowed-root')
  outsideDir = join(tmpBase, 'outside-root')
  linkTargetDir = join(tmpBase, 'link-target')
  mkdirSync(rootDir)
  mkdirSync(outsideDir)
  mkdirSync(linkTargetDir)

  const files = buildFilePlan()
  writeFixtureFiles(files)
  await seedFixture(files)
  await assertFixtureIntegrity(files)

  server = await startMaterialServer({
    database: cfg,
    databaseIssues: [],
    roots: () => [rootDir],
  })
})

after(async () => {
  if (server !== undefined) await server.close()
  if (tmpBase !== '') rmSync(tmpBase, { recursive: true, force: true })
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  真 HTTP harness（端口 0；假 webServer.register 收集 prefix 路由并按 pathname 分发）
// ---------------------------------------------------------------------------

interface RegisteredRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface MaterialServer {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly { kind: 'exact' | 'prefix'; path: string }[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/**
 * 起一个真 `node:http` server，并用 `registerMaterialContentHttp` 在其上注册路由。
 * 顺序刻意：先 listen（拿到真实端口），再把 `{host, port, register}` 传给路由——`sameOrigin`
 * 用的就是这个端口。分发模拟宿主的路由表：exact 精确匹配、prefix 最长前缀优先。
 * @param deps - 路由依赖。
 */
async function startMaterialServer(deps: MaterialContentDeps): Promise<MaterialServer> {
  const routes: RegisteredRoute[] = []
  const registered: { kind: 'exact' | 'prefix'; path: string }[] = []
  const warnings: string[] = []
  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    let chosen: RegisteredRoute | undefined
    for (const route of routes) {
      const matched = route.kind === 'exact' ? pathname === route.path : pathname.startsWith(route.path)
      if (!matched) continue
      if (chosen === undefined || route.path.length > chosen.path.length) chosen = route
    }
    if (chosen === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found (no route)' }))
      return
    }
    const target = chosen
    Promise.resolve()
      .then(() => target.handler(req, res))
      .catch(() => {
        try {
          res.destroy()
        } catch {
          // 连接已坏：忽略。
        }
      })
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpServer.address() as AddressInfo
  const dispose = registerMaterialContentHttp(
    {
      webServer: {
        host: '127.0.0.1',
        port: address.port,
        register(route) {
          registered.push({ kind: route.kind, path: route.path })
          routes.push(route as RegisteredRoute)
          return () => {
            const index = routes.indexOf(route as RegisteredRoute)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
      logger: {
        warn(message: string) {
          warnings.push(message)
        },
      },
    },
    deps,
  )
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    registered,
    warnings,
    async close(): Promise<void> {
      dispose()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}

interface HttpResult {
  readonly status: number
  readonly headers: Headers
  readonly body: Buffer
  readonly text: string
  readonly json: Record<string, unknown> | undefined
}

/** `call` 的可选参数。 */
interface CallOptions {
  readonly headers?: Readonly<Record<string, string>>
  /** 省略 `x-recruitment-request: 1`（同源反证）。 */
  readonly omitRequestHeader?: boolean
}

/**
 * 发一次同源请求（默认带 `x-recruitment-request: 1`）。
 * @param target - 服务器。
 * @param method - HTTP 方法。
 * @param path - 含 query 的路径。
 * @param options - 覆盖头 / 是否省略同源头。
 */
async function call(target: Pick<MaterialServer, 'baseUrl'>, method: string, path: string, options: CallOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.omitRequestHeader !== true) headers['x-recruitment-request'] = '1'
  const response = await fetch(`${target.baseUrl}${path}`, { method, headers, redirect: 'manual' })
  const body = Buffer.from(await response.arrayBuffer())
  const text = body.toString('utf8')
  let json: Record<string, unknown> | undefined
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = undefined
  }
  return { status: response.status, headers: response.headers, body, text, json }
}

/**
 * 用**原始 node:http** 发请求（fetch/undici 会忽略 `Host` 头覆盖，Host 反证只能这样发）。
 * @param target - 服务器。
 * @param method - HTTP 方法。
 * @param path - 请求路径。
 * @param headers - 原始头（含 Host）。
 */
async function rawCall(
  target: Pick<MaterialServer, 'port'>,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: target.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        const text = body.toString('utf8')
        let json: Record<string, unknown> | undefined
        try {
          json = JSON.parse(text) as Record<string, unknown>
        } catch {
          json = undefined
        }
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') responseHeaders.set(key, value)
          else if (Array.isArray(value)) responseHeaders.set(key, value.join(', '))
        }
        resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body, text, json })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
//  独立 SQL 零写入守卫 / 断言工具
// ---------------------------------------------------------------------------

/** 拒绝路径与读取路径都必须零写入：只数四张业务表（+ 收件/候选人做交叉核对）。 */
async function tableCounts(): Promise<Record<string, number>> {
  const rows = await query<Record<string, number>>(
    `select (select count(*)::int from recruitment.intake_asset)    as intake_asset_rows,
            (select count(*)::int from recruitment.resume)          as resume_rows,
            (select count(*)::int from recruitment.resume_version)  as resume_version_rows,
            (select count(*)::int from recruitment.application)     as application_rows,
            (select count(*)::int from recruitment.intake_record)   as intake_record_rows,
            (select count(*)::int from recruitment.event_inbox)     as event_inbox_rows`,
  )
  const counts = rows[0]
  if (counts === undefined) throw new Error('count query returned no row')
  return counts
}

/**
 * 包一次请求并断言**零写入**（四张表行数前后全等）。
 * @param label - 用例标签。
 * @param fn - 真实请求。
 */
async function assertReadOnly<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const before = await tableCounts()
  const value = await fn()
  assert.deepEqual(
    await tableCounts(),
    before,
    `${label}：请求必须零写入（intake_asset / resume / resume_version / application 行数全等）`,
  )
  return value
}

/** 同源请求 + 零写入断言。 */
async function readOnlyCall(label: string, method: string, path: string, options: CallOptions = {}): Promise<HttpResult> {
  return await assertReadOnly(label, () => call(server, method, path, options))
}

/** 原始 HTTP 请求 + 零写入断言。 */
async function readOnlyRaw(label: string, method: string, path: string, headers: Record<string, string>): Promise<HttpResult> {
  return await assertReadOnly(label, () => rawCall(server, method, path, headers))
}

/** 断言封闭错误体：`{error:{code,reason_code,message,detail?}}`（返回 error 对象便于细查）。 */
function assertProblem(result: HttpResult, status: number, code: string, reasonCode?: string): Record<string, unknown> {
  assert.equal(result.status, status, `期望 HTTP ${status}，实际 ${result.status}：${result.text.slice(0, 400)}`)
  assert.equal(result.headers.get('content-type')?.split(';')[0], 'application/json', `错误体必须是 JSON：${result.text.slice(0, 200)}`)
  const error = result.json?.error
  assert.ok(typeof error === 'object' && error !== null, `必须返回 {"error":{...}}：${result.text.slice(0, 400)}`)
  const value = error as Record<string, unknown>
  assert.equal(value.code, code, `error.code 应为 ${code}：${result.text.slice(0, 400)}`)
  if (reasonCode !== undefined) assert.equal(value.reason_code, reasonCode, `error.reason_code 应为 ${reasonCode}：${result.text.slice(0, 400)}`)
  assert.equal(typeof value.message, 'string')
  return value
}

/** 响应（头 + 体）绝不出现本机绝对路径（tmp 目录、临时根、盘符路径）。 */
function assertNoAbsolutePath(result: HttpResult, label: string): void {
  const headerText = [...result.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n')
  // 二进制安全：latin1 逐字节映射，ASCII needle 可检索。
  const bodyText = result.body.toString('latin1')
  const needles = [tmpBase, rootDir, outsideDir, linkTargetDir, tmpdir(), 'C:\\', 'C:/', '\\Users\\']
  for (const needle of needles) {
    if (needle === '') continue
    assert.equal(headerText.includes(needle), false, `${label}：响应头不得出现本机绝对路径 ${JSON.stringify(needle)}`)
    assert.equal(bodyText.includes(needle), false, `${label}：响应体不得出现本机绝对路径 ${JSON.stringify(needle)}`)
  }
}

/** 响应摘录（写进 A-material.md 的"真实响应"证据；二进制体只给长度 + 头部片段）。 */
function excerpt(result: HttpResult, maxBytes = 400): string {
  // JSON（错误体）直接给文本（含中文），便于在报告里逐字引用。
  if (result.json !== undefined) return JSON.stringify(result.text.slice(0, maxBytes))
  const head = result.body.subarray(0, 96)
  const printable = /^[\t\n\r\x20-\x7e]*$/.test(head.toString('latin1'))
  if (printable) return `<binary ${result.body.length}B> ${JSON.stringify(result.text.slice(0, 96))}`
  return `<binary ${result.body.length}B head=${JSON.stringify(head.subarray(0, 24).toString('latin1'))}>`
}

/** 关注的响应头（证据用）。 */
const EVIDENCE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'content-disposition',
  'accept-ranges', 'cache-control', 'x-content-type-options', 'allow', 'x-injected',
] as const

/** 打印一条真实响应摘要（`node --test` 会保留在输出里，A-material.md 直接引用）。 */
function logCase(label: string, result: HttpResult): void {
  const headers = EVIDENCE_HEADERS
    .filter((header) => result.headers.has(header))
    .map((header) => `${header}: ${result.headers.get(header)}`)
    .join(' | ')
  console.log(`[EVIDENCE material] ${label} → HTTP ${result.status} | ${headers} | body=${excerpt(result)}`)
}

/** 材料端点的路径。 */
function materialPath(materialId: string, query = ''): string {
  return `${MATERIAL_CONTENT_ROUTE_PREFIX}/${materialId}/content${query}`
}

// ---------------------------------------------------------------------------
//  用例 1：注册 / 路由形态 / 方法 / 非法 id（全部零写入）
// ---------------------------------------------------------------------------

test('用例1：只注册一条 prefix 路由；非回环不注册并告警；非法 id / 多余层级 / 编码穿越 / POST 全部拒绝且零写入', async () => {
  assert.equal(MATERIAL_CONTENT_ROUTE_PREFIX, '/recruitment/api/material', '前缀是契约（CONTRACT §1）')
  assert.equal(MATERIAL_CONTENT_CONTRACT_VERSION, '1.0.0')
  assert.deepEqual(
    server.registered.map((route) => `${route.kind} ${route.path}`),
    [`prefix ${MATERIAL_CONTENT_ROUTE_PREFIX}`],
    '只允许一条 prefix 路由（不给 exact 路由留第二份分发逻辑）',
  )

  // ---- 非回环 host：不注册任何路由 + 告警（fail-closed）----
  const warnings: string[] = []
  let registeredCount = 0
  const dispose = registerMaterialContentHttp(
    {
      webServer: {
        host: '0.0.0.0',
        port: 1,
        register() {
          registeredCount += 1
          return () => {}
        },
      },
      logger: { warn(message: string) { warnings.push(message) } },
    },
    { database: cfg, databaseIssues: [], roots: () => [rootDir] },
  )
  dispose()
  assert.equal(registeredCount, 0, '非回环地址不得注册任何路由')
  assert.equal(warnings.length, 1, '非回环地址必须告警')
  assert.match(warnings[0] ?? '', /不是回环地址/)
  assert.equal(warnings[0]?.includes(rootDir), false, '告警里不得出现本机路径')

  // ---- 不是本端点的形状 → 404 ----
  const bare = await readOnlyCall('前缀根路径', 'GET', MATERIAL_CONTENT_ROUTE_PREFIX)
  assertProblem(bare, 404, 'NOT_FOUND', 'ROUTE_NOT_FOUND')
  logCase('GET /recruitment/api/material（无 id）', bare)

  // ---- 非法 material_id（非 UUID / 多余层级 / 编码穿越）→ 400，且绝不进 DB/磁盘 ----
  const invalidIds: { label: string; path: string }[] = [
    { label: '非 UUID', path: materialPath('not-a-uuid') },
    { label: 'uuid 后多一层级', path: `${MATERIAL_CONTENT_ROUTE_PREFIX}/${IDS.ok.assetId}/extra/content` },
    { label: '编码穿越 ..%2F..%2Fetc', path: `${MATERIAL_CONTENT_ROUTE_PREFIX}/..%2F..%2Fetc%2Fpasswd/content` },
    { label: '编码穿越带 uuid 前缀', path: `${MATERIAL_CONTENT_ROUTE_PREFIX}/${IDS.ok.assetId}%2F..%2F..%2Fetc/content` },
  ]
  for (const item of invalidIds) {
    const result = await readOnlyCall(item.label, 'GET', item.path)
    assertProblem(result, 400, 'INVALID_ARGS', 'MATERIAL_ID_INVALID')
    assertNoAbsolutePath(result, item.label)
    logCase(`GET ${item.path}`, result)
  }

  // ---- 方法不对 → 405 + allow: GET, HEAD（只对合法路径判定方法）----
  const method = await readOnlyCall('POST 合法路径', 'POST', materialPath(IDS.ok.assetId))
  assert.equal(method.status, 405, method.text)
  assert.equal(method.headers.get('allow'), 'GET, HEAD')
  logCase(`POST ${materialPath(IDS.ok.assetId)}`, method)
})

// ---------------------------------------------------------------------------
//  用例 2：200 全文（字节全等 + 头 + 不含绝对路径 + 零写入）
// ---------------------------------------------------------------------------

test('用例2：GET 全文 → 200，body 字节全等，mime/disposition/accept-ranges/cache-control/nosniff 正确，且不泄漏绝对路径', async () => {
  const files = buildFilePlan()
  const result = await readOnlyCall('200 全文', 'GET', materialPath(IDS.ok.assetId))
  assert.equal(result.status, 200, result.text)
  assert.deepEqual(result.body, files.ok, 'body 必须与磁盘原件逐字节相等')
  assert.equal(result.headers.get('content-type'), 'application/pdf')
  assert.equal(result.headers.get('content-length'), String(files.ok.length))
  assert.equal(result.headers.get('accept-ranges'), 'bytes')
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(
    result.headers.get('content-disposition'),
    contentDispositionInline(FILE_NAME.ok),
    'disposition 必须与纯函数输出一致（inline + filename + filename*）',
  )
  assert.match(result.headers.get('content-disposition') ?? '', /^inline; filename="resume-alpha\.pdf"; filename\*=UTF-8''resume-alpha\.pdf$/)
  assertNoAbsolutePath(result, '200 全文')
  logCase('GET 200 全文（alpha 4096B）', result)

  // ---- 归属校验通过（application_id + resume_version_id 同时给）→ 仍 200 全文 ----
  const scoped = await readOnlyCall(
    '200 带归属校验',
    'GET',
    materialPath(IDS.ok.assetId, `?application_id=${IDS.ok.applicationId}&resume_version_id=${IDS.ok.resumeVersionId}`),
  )
  assert.equal(scoped.status, 200, scoped.text)
  assert.deepEqual(scoped.body, files.ok)
  logCase('GET 200（带 application_id + resume_version_id）', scoped)

  // ---- 单独给每一项也要通过 ----
  const byApplication = await readOnlyCall('200 仅 application_id', 'GET', materialPath(IDS.ok.assetId, `?application_id=${IDS.ok.applicationId}`))
  assert.equal(byApplication.status, 200, byApplication.text)
  assert.deepEqual(byApplication.body, files.ok)
  const byResumeVersion = await readOnlyCall('200 仅 resume_version_id', 'GET', materialPath(IDS.ok.assetId, `?resume_version_id=${IDS.ok.resumeVersionId}`))
  assert.equal(byResumeVersion.status, 200, byResumeVersion.text)
  assert.deepEqual(byResumeVersion.body, files.ok)

  // ---- 非法 mime（CRLF 注入尝试）+ 非 ASCII 文件名 → octet-stream + RFC5987，且没有注入出第二个头 ----
  const weird = await readOnlyCall('非法 mime + 中文文件名', 'GET', materialPath(IDS.weirdMime.assetId))
  assert.equal(weird.status, 200, weird.text)
  assert.deepEqual(weird.body, files.weirdMime)
  assert.equal(weird.headers.get('content-type'), 'application/octet-stream', '非法 mime 必须回退 octet-stream')
  assert.equal(weird.headers.has('x-injected'), false, 'mime 里的 CRLF 绝不能注入出新 header')
  const disposition = weird.headers.get('content-disposition') ?? ''
  assert.equal(
    disposition,
    `inline; filename="__ __.pdf"; filename*=UTF-8''%E7%AE%80%E5%8E%86%20%E5%8E%9F%E4%BB%B6.pdf`,
    '非 ASCII 文件名：ASCII fallback 用 "_" 占位，filename* 用 RFC5987 百分号编码',
  )
  assert.equal(disposition.includes('\r'), false, 'disposition 不得含 CR')
  assert.equal(disposition.includes('\n'), false, 'disposition 不得含 LF')
  assertNoAbsolutePath(weird, '非法 mime + 中文文件名')
  logCase('GET 200（非法 mime + 中文文件名）', weird)
})

// ---------------------------------------------------------------------------
//  用例 3：Range（闭区间 / 开区间 / 后缀 → 206；不可满足 → 416；多区间 → 忽略 Range 回 200）
// ---------------------------------------------------------------------------

test('用例3：Range 单区间 206（content-range 正确）；开区间/后缀 206；不可满足 416 + bytes */size；多区间忽略', async () => {
  const files = buildFilePlan()
  const size = files.ok.length

  const closed = await readOnlyCall('Range 0-9', 'GET', materialPath(IDS.ok.assetId), { headers: { range: 'bytes=0-9' } })
  assert.equal(closed.status, 206, closed.text)
  assert.equal(closed.headers.get('content-range'), `bytes 0-9/${size}`)
  assert.equal(closed.headers.get('content-length'), '10')
  assert.deepEqual(closed.body, files.ok.subarray(0, 10), '206 的 body 必须是 0..9 字节')
  assert.equal(closed.headers.get('accept-ranges'), 'bytes')
  assertNoAbsolutePath(closed, 'Range 0-9')
  logCase('GET Range: bytes=0-9', closed)

  const openEnded = await readOnlyCall('Range 100-', 'GET', materialPath(IDS.ok.assetId), { headers: { range: 'bytes=100-' } })
  assert.equal(openEnded.status, 206, openEnded.text)
  assert.equal(openEnded.headers.get('content-range'), `bytes 100-${size - 1}/${size}`)
  assert.deepEqual(openEnded.body, files.ok.subarray(100), '开区间必须是 100..末尾')
  logCase('GET Range: bytes=100-', openEnded)

  const suffix = await readOnlyCall('Range -16', 'GET', materialPath(IDS.ok.assetId), { headers: { range: 'bytes=-16' } })
  assert.equal(suffix.status, 206, suffix.text)
  assert.equal(suffix.headers.get('content-range'), `bytes ${size - 16}-${size - 1}/${size}`)
  assert.deepEqual(suffix.body, files.ok.subarray(size - 16), '后缀区间必须是最后 16 字节')
  logCase('GET Range: bytes=-16', suffix)

  // ---- 不可满足：起点 >= size ----
  const unsatisfiable = await readOnlyCall('Range 起点越界', 'GET', materialPath(IDS.ok.assetId), { headers: { range: `bytes=${size}-` } })
  assertProblem(unsatisfiable, 416, 'INVALID_ARGS', 'RANGE_NOT_SATISFIABLE')
  assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${size}`, '416 必须给 bytes */size')
  assert.deepEqual(unsatisfiable.json?.error, {
    code: 'INVALID_ARGS',
    reason_code: 'RANGE_NOT_SATISFIABLE',
    message: 'Range 超出资源范围',
    detail: { size },
  })
  assertNoAbsolutePath(unsatisfiable, 'Range 起点越界')
  logCase(`GET Range: bytes=${size}-`, unsatisfiable)

  // ---- 不可满足：后缀长度 0 ----
  const zeroSuffix = await readOnlyCall('Range -0', 'GET', materialPath(IDS.ok.assetId), { headers: { range: 'bytes=-0' } })
  assertProblem(zeroSuffix, 416, 'INVALID_ARGS', 'RANGE_NOT_SATISFIABLE')
  assert.equal(zeroSuffix.headers.get('content-range'), `bytes */${size}`)
  logCase('GET Range: bytes=-0', zeroSuffix)

  // ---- 多区间不支持 → 按 RFC 忽略 Range，回整份 200（不是 416）----
  const multi = await readOnlyCall('多区间', 'GET', materialPath(IDS.ok.assetId), { headers: { range: 'bytes=0-1,4-5' } })
  assert.equal(multi.status, 200, multi.text)
  assert.equal(multi.headers.has('content-range'), false)
  assert.deepEqual(multi.body, files.ok)
  logCase('GET Range: bytes=0-1,4-5（多区间）', multi)
})

// ---------------------------------------------------------------------------
//  用例 4：HEAD（同头无 body）
// ---------------------------------------------------------------------------

test('用例4：HEAD → 200 空 body 但头齐全；HEAD + Range → 206 空 body', async () => {
  const files = buildFilePlan()
  const size = files.ok.length

  const result = await readOnlyCall('HEAD', 'HEAD', materialPath(IDS.ok.assetId))
  assert.equal(result.status, 200, result.text)
  assert.equal(result.body.length, 0, 'HEAD 不得有 body')
  assert.equal(result.headers.get('content-length'), String(size))
  assert.equal(result.headers.get('content-type'), 'application/pdf')
  assert.equal(result.headers.get('content-disposition'), contentDispositionInline(FILE_NAME.ok))
  assert.equal(result.headers.get('accept-ranges'), 'bytes')
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assertNoAbsolutePath(result, 'HEAD')
  logCase('HEAD 200', result)

  const ranged = await readOnlyCall('HEAD + Range', 'HEAD', materialPath(IDS.ok.assetId), { headers: { range: 'bytes=0-9' } })
  assert.equal(ranged.status, 206, ranged.text)
  assert.equal(ranged.body.length, 0, 'HEAD + Range 也不得有 body')
  assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${size}`)
  assert.equal(ranged.headers.get('content-length'), '10')
  logCase('HEAD 206（Range: bytes=0-9）', ranged)
})

// ---------------------------------------------------------------------------
//  用例 5：404 家族（不存在 / 跨租户 / 未绑定简历 / 根外 / sha 不符 / 符号链接候选）
// ---------------------------------------------------------------------------

test('用例5：404 家族——不存在/跨租户（同码不区分）、未绑定简历、根外、sha 不符、符号链接候选；全部零写入且不含路径', async () => {
  // ---- 不存在的材料 id ----
  const missingId = '99999999-9999-4999-8999-999999999999'
  const missing = await readOnlyCall('不存在 id', 'GET', materialPath(missingId))
  assertProblem(missing, 404, 'NOT_FOUND', 'MATERIAL_NOT_FOUND')
  logCase('GET 404 不存在的 material_id', missing)

  // ---- 跨租户：asset 属于另一个租户，文件真的在允许根里（漏 tenant 过滤就会 200）----
  assert.equal(existsSync(join(rootDir, FILE_NAME.otherTenant)), true, '夹具：跨租户材料原件必须在允许根里')
  const crossTenant = await readOnlyCall('跨租户', 'GET', materialPath(IDS.otherTenant.assetId))
  const crossError = assertProblem(crossTenant, 404, 'NOT_FOUND', 'MATERIAL_NOT_FOUND')
  assert.ok(crossError.detail !== undefined, '404 应带可判的 detail（不确认"别家租户有这条"）')
  logCase('GET 404 跨租户（同租户过滤生效）', crossTenant)

  // ---- 未绑定简历：asset 存在、无同租户 resume 引用 → 404 MATERIAL_ORIGINAL_UNBOUND ----
  assert.equal(existsSync(join(rootDir, FILE_NAME.unbound)), true, '夹具：未绑定材料原件必须在允许根里')
  const unbound = await readOnlyCall('未绑定简历', 'GET', materialPath(IDS.unbound.assetId))
  assertProblem(unbound, 404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_UNBOUND')
  logCase('GET 404 未绑定简历', unbound)

  // ---- 根外：同名同 sha 的真件在允许根之外 → MATERIAL_ORIGINAL_NOT_LOCATED ----
  const outside = await readOnlyCall('根外原件', 'GET', materialPath(IDS.outside.assetId))
  const outsideError = assertProblem(outside, 404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED')
  assert.deepEqual(outsideError.detail, { reason: 'NOT_FOUND_IN_ALLOWED_ROOTS' }, 'detail 只放 resolver reason 闭集码')
  assertNoAbsolutePath(outside, '根外原件')
  logCase('GET 404 根外原件（reason=NOT_FOUND_IN_ALLOWED_ROOTS）', outside)

  // ---- sha 不符：磁盘上同名同字节数但内容不同 → 定位失败（不是 200）----
  const forged = await readOnlyCall('sha 不符', 'GET', materialPath(IDS.forged.assetId))
  const forgedError = assertProblem(forged, 404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED')
  assert.deepEqual(forgedError.detail, { reason: 'NOT_FOUND_IN_ALLOWED_ROOTS' })
  logCase('GET 404 sha 不符', forged)

  // ---- 符号链接候选：root 里只有指向根外的重解析点 → 直接跳过（不跟随）----
  const linkPath = join(rootDir, FILE_NAME.linked)
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true, '夹具：候选必须是符号链接形态')
  assert.equal(existsSync(join(linkTargetDir, FILE_NAME.linked)), true, '夹具：链接目标的真件存在（若跟随就会命中）')
  const linked = await readOnlyCall('符号链接候选', 'GET', materialPath(IDS.linked.assetId))
  const linkedError = assertProblem(linked, 404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED')
  assert.deepEqual(linkedError.detail, { reason: 'NOT_FOUND_IN_ALLOWED_ROOTS' })
  assertNoAbsolutePath(linked, '符号链接候选')
  console.log(`[EVIDENCE material] 符号链接候选形态=${linkKind}（Windows 无开发者模式时 symlinkSync('file') 会 EPERM，退化为 junction；lstat/dirent 同样报为符号链接）`)
  logCase(`GET 404 符号链接候选（${linkKind}）`, linked)

  // ---- 未配置允许根（roots: () => []）：NO_ALLOWED_ROOTS 也要如实报（另起一个 server 注入空根）----
  const noRootsServer = await startMaterialServer({ database: cfg, databaseIssues: [], roots: () => [] })
  try {
    const result = await assertReadOnly('空允许根', () => call(noRootsServer, 'GET', materialPath(IDS.ok.assetId)))
    const error = assertProblem(result, 404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED')
    assert.deepEqual(error.detail, { reason: 'NO_ALLOWED_ROOTS' }, '没有允许根 ≠ 文件不存在（如实报 NO_ALLOWED_ROOTS）')
    logCase('GET 404 空允许根（reason=NO_ALLOWED_ROOTS）', result)
  } finally {
    await noRootsServer.close()
  }
})

// ---------------------------------------------------------------------------
//  用例 6：403 / 400 家族（归属校验 / 同源 / 覆盖身份 / 未知参数）
// ---------------------------------------------------------------------------

test('用例6：403 归属校验（application / resume_version 不匹配，含不存在的 id）与同源反证；400 未知参数/覆盖身份；全部零写入', async () => {
  // 夹具前提：两条链的文件都真的在允许根里（若归属校验被跳过，就会 200）。
  assert.equal(existsSync(join(rootDir, FILE_NAME.mismatch)), true, '夹具：另一条链的原件也在允许根里')

  const cases: { label: string; path: string; code: string; reason: string }[] = [
    {
      label: 'asset 不属于该 application',
      path: materialPath(IDS.ok.assetId, `?application_id=${IDS.mismatch.applicationId}`),
      code: 'FORBIDDEN',
      reason: 'MATERIAL_NOT_LINKED_TO_APPLICATION',
    },
    {
      label: 'asset 不属于该 resume_version',
      path: materialPath(IDS.ok.assetId, `?resume_version_id=${IDS.mismatch.resumeVersionId}`),
      code: 'FORBIDDEN',
      reason: 'MATERIAL_NOT_LINKED_TO_RESUME_VERSION',
    },
    {
      label: '反向：另一条链的 asset + 本链 application',
      path: materialPath(IDS.mismatch.assetId, `?application_id=${IDS.ok.applicationId}`),
      code: 'FORBIDDEN',
      reason: 'MATERIAL_NOT_LINKED_TO_APPLICATION',
    },
    {
      label: '反向：另一条链的 asset + 本链 resume_version',
      path: materialPath(IDS.mismatch.assetId, `?resume_version_id=${IDS.ok.resumeVersionId}`),
      code: 'FORBIDDEN',
      reason: 'MATERIAL_NOT_LINKED_TO_RESUME_VERSION',
    },
    {
      label: '不存在的 application_id（fail-closed，不泄漏存在性）',
      path: materialPath(IDS.ok.assetId, '?application_id=99999999-9999-4999-8999-999999999999'),
      code: 'FORBIDDEN',
      reason: 'MATERIAL_NOT_LINKED_TO_APPLICATION',
    },
    {
      label: '不存在的 resume_version_id',
      path: materialPath(IDS.ok.assetId, '?resume_version_id=99999999-9999-4999-8999-999999999999'),
      code: 'FORBIDDEN',
      reason: 'MATERIAL_NOT_LINKED_TO_RESUME_VERSION',
    },
    {
      label: 'attachment 反证：另一条链的 asset 也不能被本链的 application 解锁',
      path: materialPath(IDS.outside.assetId, `?application_id=${IDS.ok.applicationId}`),
      code: 'FORBIDDEN',
      reason: 'MATERIAL_NOT_LINKED_TO_APPLICATION',
    },
  ]
  for (const item of cases) {
    const result = await readOnlyCall(item.label, 'GET', item.path)
    assertProblem(result, 403, item.code, item.reason)
    assertNoAbsolutePath(result, item.label)
    logCase(`GET 403 ${item.label}`, result)
  }

  // ---- 400 家族：UUID 形状 / 未知参数 / 覆盖身份（都在碰 DB 之前拒掉）----
  const badRequests: { label: string; path?: string; headers?: Record<string, string>; code: string; reason: string }[] = [
    { label: 'application_id 非 UUID', path: materialPath(IDS.ok.assetId, '?application_id=not-a-uuid'), code: 'INVALID_ARGS', reason: 'ID_NOT_UUID' },
    { label: 'resume_version_id 非 UUID', path: materialPath(IDS.ok.assetId, '?resume_version_id=not-a-uuid'), code: 'INVALID_ARGS', reason: 'ID_NOT_UUID' },
    { label: '未知查询参数', path: materialPath(IDS.ok.assetId, '?bogus=1'), code: 'INVALID_ARGS', reason: 'UNKNOWN_PARAM' },
    { label: 'query.actor_id 覆盖', path: materialPath(IDS.ok.assetId, `?actor_id=${ACTOR_103}`), code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
    { label: 'query.tenant_id 覆盖', path: materialPath(IDS.ok.assetId, `?tenant_id=${TENANT}`), code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
    { label: 'header x-recruitment-tenant 覆盖', path: materialPath(IDS.ok.assetId), headers: { 'x-recruitment-tenant': TENANT }, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
    { label: 'header x-recruitment-actor 覆盖', path: materialPath(IDS.ok.assetId), headers: { 'x-recruitment-actor': ACTOR_103 }, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
  ]
  for (const item of badRequests) {
    const result = await readOnlyCall(item.label, 'GET', item.path ?? materialPath(IDS.ok.assetId), { headers: item.headers ?? {} })
    assertProblem(result, 400, item.code, item.reason)
    assertNoAbsolutePath(result, item.label)
    logCase(`GET 400 ${item.label}`, result)
  }

  // ---- 同源反证：缺 x-recruitment-request / 跨源 Origin / Host 非法 ----
  const missingHeader = await readOnlyCall('缺同源标记头', 'GET', materialPath(IDS.ok.assetId), { omitRequestHeader: true })
  assertProblem(missingHeader, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
  logCase('GET 403 缺 x-recruitment-request', missingHeader)

  const crossOrigin = await readOnlyCall('跨源 Origin', 'GET', materialPath(IDS.ok.assetId), { headers: { origin: 'http://evil.example' } })
  assertProblem(crossOrigin, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
  logCase('GET 403 跨源 Origin', crossOrigin)

  // fetch/undici 会忽略 Host 覆盖，Host 反证必须用原始 node:http 手写头。
  const badHost = await readOnlyRaw('Host 非法', 'GET', materialPath(IDS.ok.assetId), {
    host: 'evil.example:1234',
    'x-recruitment-request': '1',
  })
  assertProblem(badHost, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED')
  logCase('GET 403 Host=evil.example:1234', badHost)

  // 反证：原始 HTTP + 正确 Host（127.0.0.1:<port>）必须放行到 200，证明上面不是"什么都 403"。
  const goodRaw = await readOnlyRaw('原始 HTTP 正确 Host', 'GET', materialPath(IDS.ok.assetId), {
    host: `127.0.0.1:${server.port}`,
    'x-recruitment-request': '1',
  })
  assert.equal(goodRaw.status, 200, goodRaw.text)
  assert.deepEqual(goodRaw.body, buildFilePlan().ok, '原始 HTTP 正确 Host 必须拿到原件字节')
  logCase('GET 200（原始 HTTP + 正确 Host）', goodRaw)
})

// ---------------------------------------------------------------------------
//  用例 7：503 未配置（路由仍在，但不假装成功）
// ---------------------------------------------------------------------------

test('用例7：database=null → 503 NOT_CONFIGURED（detail.issues 原样给出，零写入）', async () => {
  const unconfigured = await startMaterialServer({
    database: null,
    databaseIssues: ['config.database.host is required'],
    roots: () => [rootDir],
  })
  try {
    const result = await assertReadOnly('未配置', () => call(unconfigured, 'GET', materialPath(IDS.ok.assetId)))
    const error = assertProblem(result, 503, 'NOT_CONFIGURED', 'NOT_CONFIGURED')
    assert.deepEqual(error.detail, { issues: ['config.database.host is required'] })
    assertNoAbsolutePath(result, '未配置')
    logCase('GET 503 未配置', result)
  } finally {
    await unconfigured.close()
  }
})

// ---------------------------------------------------------------------------
//  用例 8：纯函数边界（Range / Content-Disposition / Content-Type / 路径形状）
// ---------------------------------------------------------------------------

test('用例8：纯函数边界——parseByteRange / contentDispositionInline / contentTypeFor / parseMaterialContentPath', () => {
  // ---- parseByteRange：忽略（FULL）/ 可满足（PARTIAL）/ 不可满足（UNSATISFIABLE）三态 ----
  assert.deepEqual(parseByteRange(undefined, 10), { kind: 'FULL' })
  assert.deepEqual(parseByteRange(null, 10), { kind: 'FULL' })
  assert.deepEqual(parseByteRange('bytes=0-4', 10), { kind: 'PARTIAL', start: 0, end: 4 })
  assert.deepEqual(parseByteRange('bytes=4-', 10), { kind: 'PARTIAL', start: 4, end: 9 })
  assert.deepEqual(parseByteRange('bytes=-4', 10), { kind: 'PARTIAL', start: 6, end: 9 })
  assert.deepEqual(parseByteRange('bytes=0-999', 10), { kind: 'PARTIAL', start: 0, end: 9 }, '越界 end 截到 size-1')
  assert.deepEqual(parseByteRange('bytes=9-10', 10), { kind: 'PARTIAL', start: 9, end: 9 })
  assert.deepEqual(parseByteRange('bytes=-999', 10), { kind: 'PARTIAL', start: 0, end: 9 }, '超长后缀退化为整份')
  assert.deepEqual(parseByteRange('bytes=10-', 10), { kind: 'UNSATISFIABLE' }, '起点 >= size 不可满足')
  assert.deepEqual(parseByteRange('bytes=-0', 10), { kind: 'UNSATISFIABLE' }, '零后缀不可满足')
  assert.deepEqual(parseByteRange('bytes=99999999999999999999-', 10), { kind: 'UNSATISFIABLE' })
  assert.deepEqual(parseByteRange('bytes=5-3', 10), { kind: 'FULL' }, 'last < first = 语法非法 → 忽略')
  assert.deepEqual(parseByteRange('bytes=abc', 10), { kind: 'FULL' }, '不合法 Range 必须忽略')
  assert.deepEqual(parseByteRange('items=0-1', 10), { kind: 'FULL' }, '非 bytes 单位必须忽略')
  assert.deepEqual(parseByteRange('bytes=0-1,4-5', 10), { kind: 'FULL' }, '多区间不支持 → 忽略')

  // ---- contentDispositionInline：basename / 去引号控制字符 / RFC5987 / ASCII fallback ----
  assert.equal(contentDispositionInline('a.pdf'), `inline; filename="a.pdf"; filename*=UTF-8''a.pdf`)
  assert.equal(
    contentDispositionInline('C:\\Users\\hr\\简历 原件.pdf'),
    `inline; filename="__ __.pdf"; filename*=UTF-8''%E7%AE%80%E5%8E%86%20%E5%8E%9F%E4%BB%B6.pdf`,
    '必须 basename 化（去掉路径片段）并做 ASCII fallback + RFC5987',
  )
  const injected = contentDispositionInline('a\r\nx-injected: 1.pdf')
  assert.equal(injected.includes('\r'), false)
  assert.equal(injected.includes('\n'), false)
  assert.equal(contentDispositionInline(''), `inline; filename="material"; filename*=UTF-8''material`)

  // ---- contentTypeFor：只认 type/subtype；非法/缺失 → octet-stream ----
  assert.equal(contentTypeFor('application/pdf'), 'application/pdf')
  assert.equal(contentTypeFor('Application/PDF; charset=binary'), 'application/pdf')
  assert.equal(contentTypeFor('application/pdf\r\nx-injected: 1'), 'application/octet-stream')
  assert.equal(contentTypeFor('not a mime'), 'application/octet-stream')
  assert.equal(contentTypeFor(''), 'application/octet-stream')
  assert.equal(contentTypeFor(null), 'application/octet-stream')
  assert.equal(contentTypeFor(undefined), 'application/octet-stream')

  // ---- parseMaterialContentPath：只认 `<prefix>/<uuid>/content` ----
  assert.deepEqual(
    parseMaterialContentPath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/${IDS.ok.assetId}/content`),
    { kind: 'OK', materialId: IDS.ok.assetId },
  )
  assert.deepEqual(parseMaterialContentPath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/${IDS.ok.assetId}/content/extra`), { kind: 'NOT_FOUND' })
  assert.deepEqual(parseMaterialContentPath(MATERIAL_CONTENT_ROUTE_PREFIX), { kind: 'NOT_FOUND' })
  assert.deepEqual(parseMaterialContentPath('/recruitment/api/other/x/content'), { kind: 'NOT_FOUND' })
  assert.deepEqual(parseMaterialContentPath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/x/content`), { kind: 'INVALID' })
  assert.deepEqual(parseMaterialContentPath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/${IDS.ok.assetId}/x/content`), { kind: 'INVALID' })
  assert.deepEqual(parseMaterialContentPath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/..%2F..%2Fetc/content`), { kind: 'INVALID' })
})
