// P1 #5 · 干净库 seed 自洽（bootstrap-demo 的 `seed.demo_material`）× 真实 PostgreSQL。
//
// 被测事实（缺陷）：干净库按 0002_seed 落下的演示申请 …0701 是空壳（没有 resume_version），
// 但 D5 演示种子把面试 …0801/…0802 挂在 …0701 上 —— "无材料却有已排期面试"是业务事实矛盾。
//
// 本文件在**一次性空库**（重放 0001→0016）上 spawn 产品脚本 `scripts/bootstrap-demo.mjs`
// 两遍（真提交、跨进程），断言：
//   (a) 第 1 遍 exit 0、outcome=BOOTSTRAPPED，`seed.demo_material.state=APPENDED`；
//   (b) 独立 psql 语义读回（直接 SQL，不 import 材料写入代码）：application→resume_version→
//       resume→intake_asset→intake_record 整链字段非空、candidate 是 …0601、材料 sha256/字节数
//       与脚本报告的**真实 RTF 字节**一致、parse_status=PARSED 且 work_experience entry_count≥1；
//   (c) 两场面试都属于 …0701 且拿得到同一 resume_version（"有面试必有材料"）；
//   (d) 全租户「有面试却无材料」计数 = 0（反例由 (e) 的反证查询证明不是恒 0）；
//   (e) 第 2 遍（**故意给一个不存在的 python**）exit 0、outcome=NO_OP、`seed.demo_material.state=PRESENT`，
//       且业务表逐表行数与第 1 遍之后**完全相同**（重跑零写入；材料已在库时不需要 Python）。
//
// 为什么必须独占一次性库：bootstrap 会真提交（审批 / actor / 面试 / 材料 / rubric 版本），
// 共享库 ra_s6s7 不允许被测试写；且"逐表行数不变"只有在没有别人并发的库上才可复现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertPrivateDatabase, createIsolatedTestDatabase, type IsolatedTestDatabase } from './db.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, 'scripts', 'bootstrap-demo.mjs')

const TENANT = '11111111-1111-4111-8111-000000000001'
const APP_0701 = '11111111-1111-4111-8111-000000000701'
const CANDIDATE_0601 = '11111111-1111-4111-8111-000000000601'
const INTERVIEW_0801 = '11111111-1111-4111-8111-000000000801'
const INTERVIEW_0802 = '11111111-1111-4111-8111-000000000802'

/** 逐表行数快照（"重跑零写入"的证据；只列会被本脚本触碰的业务表）。 */
const COUNT_TABLES = [
  'application', 'resume', 'resume_version', 'intake_asset', 'intake_record', 'event_inbox',
  'interview', 'interviewer', 'job', 'job_version', 'approval', 'rubric_version', 'actor', 'actor_role',
] as const

/** 一次性库句柄。 */
let db: IsolatedTestDatabase

test.before(async () => {
  db = await createIsolatedTestDatabase('p1_seed_bootstrap')
  // 真提交 + 跨进程 spawn：必须是独占库，不是共享的 ra_s6s7。
  assertPrivateDatabase(db.name)
})

test.after(async () => {
  if (db !== undefined) await db.drop()
})

/**
 * 在 PATH 上找 python（converter 的 python_bin 必须是绝对路径）。
 * 与 `scripts/bootstrap-demo.mjs::findPythonOnPath()` 同口径；找不到返回 null。
 * @returns 绝对路径或 null。
 */
function findPythonOnPath(): string | null {
  const isWindows = process.platform === 'win32'
  const sep = isWindows ? ';' : ':'
  const exts = isWindows ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter((x) => x !== '') : ['']
  const names = isWindows ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  for (const dir of String(process.env.PATH ?? '').split(sep)) {
    if (dir.trim() === '') continue
    for (const name of names) {
      for (const ext of exts) {
        const candidate = join(dir.trim(), `${name}${ext}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

/**
 * 给 bootstrap 子进程的 env：显式把一次性库名映射到 `RECRUITMENT_DB_NAME`
 * （测试主配置是 `RECRUITMENT_TEST_DB`，bootstrap 认 `RECRUITMENT_DB_NAME`，不能混）。
 * @param pythonBinOverride - 覆盖 python_bin（第 2 遍故意给不存在的绝对路径，证明重跑不需要 Python）。
 * @returns 子进程 env。
 */
function bootstrapEnv(pythonBinOverride?: string): NodeJS.ProcessEnv {
  const pythonBin = pythonBinOverride ?? process.env.RECRUITMENT_PYTHON_BIN ?? findPythonOnPath()
  assert.ok(pythonBin !== null && pythonBin !== undefined && pythonBin !== '',
    '找不到 python：converter 需要绝对路径的 python_bin（设置 RECRUITMENT_PYTHON_BIN 或放进 PATH）')
  return {
    ...process.env,
    RECRUITMENT_DB_HOST: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
    RECRUITMENT_DB_PORT: process.env.RECRUITMENT_TEST_DB_PORT ?? '5432',
    RECRUITMENT_DB_USER: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
    RECRUITMENT_DB_NAME: db.name,
    RECRUITMENT_DB_PASSWORD: process.env.RECRUITMENT_DB_PASSWORD,
    RECRUITMENT_PYTHON_BIN: pythonBin,
    DEMO_APPROVAL_MODE: 'allow-once',
  }
}

/** 跑一遍 `scripts/bootstrap-demo.mjs` 并解析末行 `BOOTSTRAP_RESULT`（真子进程、真 exit code）。 */
function runBootstrap(pythonBinOverride?: string): { status: number | null; result: Record<string, any>; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [BOOTSTRAP_SCRIPT], {
    cwd: REPO_ROOT,
    env: bootstrapEnv(pythonBinOverride),
    encoding: 'utf8',
    timeout: 300_000,
  })
  assert.equal(child.error, undefined, `spawn bootstrap 失败：${String(child.error)}`)
  const stdout = String(child.stdout ?? '')
  const stderr = String(child.stderr ?? '')
  const resultLine = stdout.split(/\r?\n/).filter((line) => line.startsWith('BOOTSTRAP_RESULT: ')).pop()
  assert.ok(resultLine !== undefined, `stdout 没有 BOOTSTRAP_RESULT 行。\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  const result = JSON.parse(resultLine.slice('BOOTSTRAP_RESULT: '.length)) as Record<string, any>
  return { status: child.status, result, stdout, stderr }
}

/** 读一条申请沿材料链的整链事实（application → resume_version → resume → intake_asset → intake_record → event）。 */
async function readChain(applicationId: string): Promise<Record<string, any> | null> {
  const { rows } = await db.pool.query(
    `select a.id as application_id, a.resume_version_id, a.current_stage_code,
            rv.id as resume_version_row_id, rv.version_no, rv.parse_status, rv.content_sha256,
            rv.parsed_fields,
            r.id as resume_id, r.candidate_id,
            ia.id as intake_asset_row_id, ia.sha256 as asset_sha256, ia.byte_size, ia.storage_ref,
            ia.intake_record_id,
            ir.id as intake_record_row_id, ir.status as intake_status, ir.event_id,
            e.event_id as event_row_id, e.event_type
       from recruitment.application a
       join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
       join recruitment.resume r on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       join recruitment.intake_asset ia on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
       join recruitment.intake_record ir on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
       left join recruitment.event_inbox e on e.event_id = ir.event_id and e.tenant_id = ir.tenant_id
      where a.tenant_id = $1 and a.id = $2`,
    [TENANT, applicationId],
  )
  return rows[0] ?? null
}

/** 全租户「有面试却无材料」的面试行。 */
async function interviewsWithoutMaterial(): Promise<readonly Record<string, any>[]> {
  const { rows } = await db.pool.query(
    `select i.id as interview_id, i.application_id, i.round_no, i.status
       from recruitment.interview i
       join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
      where i.tenant_id = $1 and a.resume_version_id is null
      order by i.round_no, i.id`,
    [TENANT],
  )
  return rows
}

/** 逐表行数快照。 */
async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of COUNT_TABLES) {
    const { rows } = await db.pool.query(`select count(*)::int as n from recruitment.${table}`)
    out[table] = Number(rows[0]?.n ?? -1)
  }
  return out
}

test('P1 #5：干净库首跑给 …0701 补齐真实材料链，重跑零写入且「有面试必有材料」', async () => {
  // ---- 第 1 遍：干净库 + 当前 bootstrap（真子进程，exit 0 才算过）----
  const first = runBootstrap()
  assert.equal(first.status, 0, `bootstrap 首次运行 exit=${String(first.status)}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`)
  assert.equal(first.result.outcome, 'BOOTSTRAPPED', `outcome=${String(first.result.outcome)}`)
  assert.equal(first.result.exit_code, 0)
  assert.ok(Array.isArray(first.result.writes?.steps) && first.result.writes.steps.includes('seed.demo_material'),
    `writes 里应含 seed.demo_material，实际 ${JSON.stringify(first.result.writes)}`)

  const material = first.result.seed?.demo_material
  assert.ok(material !== null && typeof material === 'object', 'BOOTSTRAP_RESULT.seed.demo_material 缺失')
  assert.equal(material.state, 'APPENDED')
  assert.equal(material.application_id, APP_0701)
  assert.equal(material.candidate_id, CANDIDATE_0601)
  assert.match(String(material.sha256), /^[0-9a-f]{64}$/, '材料 sha256 必须是真实 64 位 hex')
  assert.ok(Number(material.byte_size) > 0)
  assert.equal(material.chain_ok, true)
  assert.equal(material.hash_match, true)
  assert.equal(material.parse_ok, true)
  assert.equal(first.result.seed?.invariant?.ok, true)
  assert.equal(first.result.seed?.invariant?.interviews_without_material, 0)

  // ---- (b) 独立 SQL 读回整链（不看脚本自述，sha/字节数/解析结论逐条对账）----
  const chain = await readChain(APP_0701)
  assert.ok(chain !== null, '独立读回：application→resume_version→resume→intake_asset→intake_record 整链不可达')
  for (const key of [
    'resume_version_id', 'resume_version_row_id', 'resume_id', 'intake_asset_row_id',
    'intake_record_row_id', 'event_row_id', 'event_type',
  ]) {
    assert.ok(chain[key] !== null && chain[key] !== undefined && chain[key] !== '', `整链字段 ${key} 为空`)
  }
  assert.equal(chain.application_id, APP_0701)
  assert.equal(chain.candidate_id, CANDIDATE_0601)
  assert.equal(chain.parse_status, 'PARSED')
  assert.equal(chain.asset_sha256, material.sha256, 'intake_asset.sha256 必须等于脚本生成 RTF 的 sha256')
  assert.equal(Number(chain.byte_size), Number(material.byte_size), 'intake_asset.byte_size 必须等于脚本生成 RTF 字节数')
  assert.equal(chain.storage_ref, `content-addressed:sha256:${chain.asset_sha256}`, 'storage_ref 必须是内容寻址（无机器路径）')
  assert.equal(chain.parsed_fields?.fields?.phone?.state, 'present')
  assert.equal(chain.parsed_fields?.fields?.email?.state, 'present')
  assert.equal(chain.parsed_fields?.fields?.work_experience?.state, 'present')
  assert.ok(Number(chain.parsed_fields?.fields?.work_experience?.entry_count ?? 0) >= 1)

  // ---- (c) 两场面试都挂在 …0701 且拿得到同一个 resume_version ----
  const interviews = await db.pool.query(
    `select id, application_id, round_no, status from recruitment.interview
      where tenant_id = $1 and id in ($2, $3) order by round_no`,
    [TENANT, INTERVIEW_0801, INTERVIEW_0802],
  )
  assert.equal(interviews.rows.length, 2, '演示面试 …0801/…0802 应存在')
  for (const row of interviews.rows) {
    assert.equal(row.application_id, APP_0701)
    const bound = await db.pool.query(
      'select resume_version_id from recruitment.application where tenant_id = $1 and id = $2',
      [TENANT, row.application_id],
    )
    assert.equal(bound.rows[0]?.resume_version_id, chain.resume_version_row_id,
      `面试 ${String(row.id)} 的申请没有指向同一条 resume_version`)
  }

  // ---- (d) 全租户「有面试却无材料」= 0 ----
  assert.deepEqual(await interviewsWithoutMaterial(), [])

  // ---- (e) 第 2 遍：给一个**不存在的 python**，证明材料已在库时重跑不需要 Python 且零写入 ----
  const before = await rowCounts()
  const absentPython = process.platform === 'win32' ? 'Z:\\no-such-python\\python.exe' : '/nonexistent/python'
  const second = runBootstrap(absentPython)
  assert.equal(second.status, 0, `bootstrap 重跑 exit=${String(second.status)}\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`)
  assert.equal(second.result.outcome, 'NO_OP', `重跑 outcome=${String(second.result.outcome)}（应 NO_OP）`)
  assert.equal(second.result.writes?.written, false, `重跑不应写库：${JSON.stringify(second.result.writes)}`)
  assert.equal(second.result.seed?.demo_material?.state, 'PRESENT')
  assert.equal(second.result.seed?.demo_material?.sha256, material.sha256, '重跑读回的材料 sha256 必须与首跑一致')
  const after = await rowCounts()
  assert.deepEqual(after, before, `重跑后行数必须逐表不变（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`)

  // ---- (f) 反证：把 …0701 的材料指针临时清空 → 不变量查询必须报出 1 行（证明 (d) 不是恒 0）----
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", ['11111111-1111-4111-8111-000000000103'])
    await client.query('update recruitment.application set resume_version_id = null where tenant_id = $1 and id = $2',
      [TENANT, APP_0701])
    const { rows } = await client.query(
      `select i.id from recruitment.interview i
         join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
        where i.tenant_id = $1 and a.resume_version_id is null`,
      [TENANT],
    )
    assert.equal(rows.length, 2, '清空材料指针后，反例查询必须报出 …0801/…0802 两场（证明不变量查询会失败）')
  } finally {
    await client.query('rollback')
    client.release()
  }
  // 回滚后事实恢复：整链仍在。
  assert.equal((await readChain(APP_0701))?.resume_version_id, chain.resume_version_id)
})
