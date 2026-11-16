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
// O3（钉住的 rubric 必须可执行）也在本文件守：首跑必须把 …0701 从不可执行的 seed v1（…0403）
// 重绑到 bootstrap 自己创建并批准的 v2 ⇒ `seed.demo_rubric_repair.state=REBOUND`、`pinned_after`
// 等于 `job.current_rubric_version_id`；独立 SQL 读回"钉住版本里没有既无 field 又无 question 的
// criteria（R-VAL-12）+ 有生效 APPROVED"；重跑 `state=NO_OP` 且 application 的 pin/record_version
// 不变；最后用产品 `createScreeningEvaluateTool` 对 …0701 真 execute，证明初筛真的能出结论。
//
// 为什么必须独占一次性库：bootstrap 会真提交（审批 / actor / 面试 / 材料 / rubric 版本），
// 共享库 ra_s6s7 不允许被测试写；且"逐表行数不变"只有在没有别人并发的库上才可复现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// O3：真工具调用用产品自己的 S7 工具（createScreeningEvaluateTool），证明"修复后初筛真的可执行"。
import { createScreeningEvaluateTool } from '../../src/tools/screening-evaluate.ts'
import { assertPrivateDatabase, createIsolatedTestDatabase, testDatabaseConfig, type IsolatedTestDatabase } from './db.ts'

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

// ---------------------------------------------------------------------------
//  O3：申请钉住的 rubric 版本必须可执行（`seed.demo_rubric_repair`）
// ---------------------------------------------------------------------------

/** O3 的独立 SQL 读回形状（不 import 产品代码：直接看 application / rubric_version / approval）。 */
interface PinnedRubricFacts {
  readonly pinnedRubricVersionId: string | null
  readonly jobCurrentRubricVersionId: string | null
  readonly pinnedVersionNo: number | null
  readonly pinnedPayloadHash: string | null
  readonly criteriaCount: number | null
  /** dimensions 里"既没有 field 也没有 question"的 criteria 数（R-VAL-12 会判非法，要求 0）。 */
  readonly judgmentWithoutQuestion: number
  /** 生效 APPROVED 审批（status/hash/未 supersede/未过期/schema=1）的行数。 */
  readonly effectiveApprovalCount: number
}

/**
 * 独立 SQL 读回「申请 …0701 钉住哪个 rubric 版本 + 该版本是否可执行 + 审批是否生效」。
 * 口径：判断型（field 为空）必须有非空 `question`；审批按 JR §4.2 的 EXISTS 判据。
 */
async function readPinnedRubricFacts(): Promise<PinnedRubricFacts> {
  const { rows } = await db.pool.query(
    `select a.rubric_version_id::text          as pinned_rubric_version_id,
            j.current_rubric_version_id::text  as job_current_rubric_version_id,
            rv.version_no,
            rv.payload_hash,
            jsonb_array_length(rv.dimensions)  as criteria_count,
            (select count(*)::int
               from jsonb_array_elements(rv.dimensions) c
              where coalesce(c->>'field', '') = ''
                and coalesce(c->>'question', '') = '') as judgment_without_question,
            (select count(*)::int
               from recruitment.approval ap
              where ap.tenant_id = a.tenant_id
                and ap.resource_type = 'RUBRIC_VERSION'
                and ap.resource_id = rv.id
                and ap.status = 'APPROVED'
                and ap.payload_schema_version = 1
                and ap.canonical_payload_hash = rv.payload_hash
                and ap.superseded_by_approval_id is null
                and (ap.expires_at is null or ap.expires_at > now())) as effective_approval_count
       from recruitment.application a
       join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
       join recruitment.rubric_version rv on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
      where a.tenant_id = $1 and a.id = $2`,
    [TENANT, APP_0701],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `申请 ${APP_0701} 必须存在且钉住一个 rubric 版本（独立 SQL 读回为空）`)
  return {
    pinnedRubricVersionId: row.pinned_rubric_version_id ?? null,
    jobCurrentRubricVersionId: row.job_current_rubric_version_id ?? null,
    pinnedVersionNo: row.version_no === null ? null : Number(row.version_no),
    pinnedPayloadHash: row.payload_hash ?? null,
    criteriaCount: row.criteria_count === null ? null : Number(row.criteria_count),
    judgmentWithoutQuestion: Number(row.judgment_without_question ?? -1),
    effectiveApprovalCount: Number(row.effective_approval_count ?? -1),
  }
}

/** 申请 …0701 的 pin + record_version（"重跑零写入"的对账口径）。 */
async function readApplicationPin(): Promise<{ rubric_version_id: string | null; record_version: number }> {
  const { rows } = await db.pool.query(
    `select rubric_version_id::text as rubric_version_id, record_version
       from recruitment.application where tenant_id = $1 and id = $2`,
    [TENANT, APP_0701],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `申请 ${APP_0701} 必须存在`)
  return { rubric_version_id: row.rubric_version_id ?? null, record_version: Number(row.record_version) }
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

  // ---- (a2) O3：首跑必须把 …0701 从**不可执行**的 v1 重绑到已批准且可执行的 v2 ----
  // 根因：0002_seed 的 rubric v1（…0403）三条判断型 criteria 都没有 question → R-VAL-12 全非法；
  // 申请钉死在 v1 ⇒ screening_evaluate 必 NO_RUBRIC/RUBRIC_INVALID。
  const repair = first.result.seed?.demo_rubric_repair
  assert.ok(repair !== null && typeof repair === 'object', 'BOOTSTRAP_RESULT.seed.demo_rubric_repair 缺失')
  assert.equal(repair.application_id, APP_0701)
  assert.equal(repair.state, 'REBOUND', `首跑 repair.state=${String(repair.state)}（应 REBOUND）`)
  assert.equal(repair.write, true, '首跑 repair 必须真写入')
  assert.equal(repair.executable_before, false, '首跑 pinned（v1）必须被判定为不可执行')
  assert.equal(repair.executable_after, true, '首跑重绑后的版本必须可执行')
  assert.equal(repair.pinned_before?.version_no, 1, '首跑 pinned_before 必须是 seed 的 v1')
  assert.equal(repair.pinned_after?.version_no, 2, '首跑 pinned_after 必须是 bootstrap 创建的 v2')
  assert.equal(repair.pinned_after?.rubric_version_id, first.result.job?.current_rubric_version_id,
    '首跑 pinned_after 必须等于 job.current_rubric_version_id')
  assert.ok(
    Array.isArray(repair.violations_before)
      && repair.violations_before.length === 3
      && repair.violations_before.every((row: Record<string, unknown>) => row.rule === 'R-VAL-12' && row.reason_code === 'CRITERION_QUESTION'),
    `首跑 violations_before 必须是 3 条 R-VAL-12/CRITERION_QUESTION，实际 ${JSON.stringify(repair.violations_before)}`,
  )
  assert.ok(
    Array.isArray(first.result.writes?.steps) && first.result.writes.steps.includes('seed.demo_rubric_repair'),
    `writes.steps 里应含 seed.demo_rubric_repair，实际 ${JSON.stringify(first.result.writes)}`,
  )
  // 人读 stdout 里也必须有一行可机检的 O3 步骤（不只看 JSON）。
  const repairStepLine = first.stdout.split(/\r?\n/).find((line) =>
    line.includes('seed.demo_rubric_repair') && line.includes('pinned_before='))
  assert.ok(repairStepLine !== undefined, `stdout 缺 seed.demo_rubric_repair 步骤行。\nstdout:\n${first.stdout}`)
  assert.match(repairStepLine, /executable_before=false/, `步骤行缺 executable_before=false：${repairStepLine}`)
  assert.match(repairStepLine, /executable_after=true/, `步骤行缺 executable_after=true：${repairStepLine}`)
  assert.match(repairStepLine, /reason=REBOUND_TO_APPROVED_EXECUTABLE_RUBRIC/,
    `步骤行缺 reason：${repairStepLine}`)

  // ---- (a3) 独立 SQL 读回（不 import 产品代码）：pin 指向 job.current；可执行；审批生效 ----
  const pinnedFacts = await readPinnedRubricFacts()
  assert.equal(pinnedFacts.pinnedRubricVersionId, pinnedFacts.jobCurrentRubricVersionId,
    '独立 SQL：申请钉住的版本必须等于 job.current_rubric_version_id')
  assert.equal(pinnedFacts.pinnedRubricVersionId, repair.pinned_after?.rubric_version_id,
    '独立 SQL：申请钉住的版本必须等于 repair.pinned_after')
  assert.equal(pinnedFacts.pinnedVersionNo, 2, '独立 SQL：钉住的版本应是 v2（bootstrap 创建并批准）')
  assert.match(String(pinnedFacts.pinnedPayloadHash), /^[0-9a-f]{64}$/, '独立 SQL：payload_hash 必须是 64 位 hex')
  assert.ok(Number(pinnedFacts.criteriaCount ?? 0) >= 1, '独立 SQL：钉住的版本必须至少 1 条 criteria')
  assert.equal(pinnedFacts.judgmentWithoutQuestion, 0,
    '独立 SQL：钉住版本里不允许出现「既没有 field 也没有 question」的 criteria（R-VAL-12）')
  assert.equal(pinnedFacts.effectiveApprovalCount, 1,
    '独立 SQL：钉住版本必须恰有 1 条生效 APPROVED（status/hash/未 superseded/未过期/schema=1）')

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
  const beforePin = await readApplicationPin()
  const before = await rowCounts()
  const absentPython = process.platform === 'win32' ? 'Z:\\no-such-python\\python.exe' : '/nonexistent/python'
  const second = runBootstrap(absentPython)
  assert.equal(second.status, 0, `bootstrap 重跑 exit=${String(second.status)}\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`)
  assert.equal(second.result.outcome, 'NO_OP', `重跑 outcome=${String(second.result.outcome)}（应 NO_OP）`)
  assert.equal(second.result.writes?.written, false, `重跑不应写库：${JSON.stringify(second.result.writes)}`)
  assert.equal(second.result.seed?.demo_material?.state, 'PRESENT')
  assert.equal(second.result.seed?.demo_material?.sha256, material.sha256, '重跑读回的材料 sha256 必须与首跑一致')
  // O3：重跑时 pin 已可执行 → NO_OP、零写入、application 的 pin/record_version 都不变。
  const secondRepair = second.result.seed?.demo_rubric_repair
  assert.equal(secondRepair?.state, 'NO_OP', `重跑 repair.state=${String(secondRepair?.state)}（应 NO_OP）`)
  assert.equal(secondRepair?.write, false, '重跑 repair 不得写入')
  assert.equal(secondRepair?.executable_before, true, '重跑 executable_before 必须是 true')
  assert.equal(secondRepair?.executable_after, true, '重跑 executable_after 必须是 true')
  assert.equal(secondRepair?.pinned_after?.rubric_version_id, beforePin.rubric_version_id,
    '重跑 repair.pinned_after 必须等于重跑前的 pin')
  assert.equal(secondRepair?.reason, 'NO_OP_PINNED_RUBRIC_EXECUTABLE')
  const after = await rowCounts()
  assert.deepEqual(after, before, `重跑后行数必须逐表不变（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`)
  const afterPin = await readApplicationPin()
  assert.equal(afterPin.rubric_version_id, beforePin.rubric_version_id,
    '重跑绝不能改 application.rubric_version_id（幂等硬要求）')
  assert.equal(afterPin.record_version, beforePin.record_version,
    '重跑绝不能改 application.record_version（幂等硬要求）')

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

  // ---- (g) O3 的可执行性证明：用**产品自己的** S7 工具真 execute（不再 NO_RUBRIC/RUBRIC_INVALID）----
  // 这条是最关键的一条：夹具修复的验收标准不是"JSON 里写了 REBOUND"，而是"初筛真的能出结论"。
  const screeningTool = createScreeningEvaluateTool({ ...testDatabaseConfig(), database: db.name })
  const evaluation = await screeningTool.execute(
    { application_id: APP_0701 },
    { callId: 'seed-test-screening' },
  ) as Record<string, any>
  assert.equal(evaluation.criteria_evaluated, true,
    `criteria_evaluated 必须 true（否则初筛仍不可执行）：${JSON.stringify(evaluation).slice(0, 2000)}`)
  assert.ok(['PASS', 'FAIL', 'NEEDS_REVIEW'].includes(String(evaluation.verdict)),
    `verdict 必须是三态之一，实际 ${String(evaluation.verdict)}`)
  assert.equal(evaluation.rubric?.version_no, 2,
    `初筛用的 rubric 版本必须是 v2，实际 ${JSON.stringify(evaluation.rubric)}`)
  assert.equal(evaluation.rubric?.version_id, afterPin.rubric_version_id,
    '初筛用的 rubric 版本必须等于申请钉住的版本')
  assert.equal(evaluation.rubric?.resolution, 'APPLICATION_PINNED',
    `初筛必须按申请钉住的版本解析，实际 ${String(evaluation.rubric?.resolution)}`)
  // `rubric_quality` 在当前产品实现里是输出键（可选键）；断言存在，并把实际值打进失败消息便于诊断。
  assert.ok('rubric_quality' in evaluation,
    `rubric_quality 实际值：${JSON.stringify(evaluation.rubric_quality)}`)
})
