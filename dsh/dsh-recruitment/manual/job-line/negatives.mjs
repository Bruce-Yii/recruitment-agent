// 岗位线负例（**真实 PG ra_s6s7**）：把 SPEC §9.3 / §7 的失败路径逐条打出来。
//
// 与单测/集成测的分工：单测证明规则，集成测证明事务内语义，本脚本证明
// **真实工具入口 + 真连接 + 真提交** 上的错误原文（含 SQLSTATE）。
//
// 重要：这些用例会**真写库**（历史事实禁删，见 0001_init.sql 的 fn_block_delete）。
//   * 每次用唯一 code（前缀 `S3N-<run>-`），脚本开头打印前缀；
//   * 创建成功后**立刻**打印 job_id / approval_id；
//   * 结尾汇总本次创建的所有 job_id，便于人工取证/清理决策。
// 脚本**不删任何行**。
//
// 用法（PowerShell，在 dsh/dsh-recruitment 下）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/job-line/negatives.mjs
import {
  createJobCreateTool,
  createJobUpdateTool,
  decideRubricApproval,
} from '../../src/tools/job-create.ts'
import { createJobGetTool } from '../../src/tools/job-get.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const database = resolveDatabaseConfig({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, process.env)
if (database.resolved === null) {
  console.error('database config issues:', database.issues)
  process.exit(2)
}
const cfg = database.resolved
const create = createJobCreateTool(cfg)
const update = createJobUpdateTool(cfg)
const get = createJobGetTool(cfg)
const signal = new AbortController().signal

/** 本次运行的唯一 code 前缀（`^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$`）。 */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase()
let sequence = 0
const nextCode = () => `S3N-${RUN}-${sequence += 1}`

/** 两条机械型 MUST_HAVE，Σweight = 1（R-VAL-6/13 的合法基线）。 */
const GOOD_CRITERIA = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months_gte36', label: '至少 36 个月', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 36 },
]

const created = []
const failures = []

function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** 调工具，把抛错原样带回来（不吞、不改写）。 */
async function call(tool, args) {
  try {
    return { ok: true, value: await tool.execute(args, { signal }) }
  } catch (error) {
    return { ok: false, error }
  }
}

/** 调人类批准动作（不是模型工具），同样不吞错。 */
async function decide(input) {
  try {
    return { ok: true, value: await decideRubricApproval(cfg, input) }
  } catch (error) {
    return { ok: false, error }
  }
}

/** `Error: <CODE>: <compact-json>` 的 JSON 体。 */
function bodyOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const body = JSON.parse(index >= 0 ? message.slice(index + 2) : message)
  return { message, body }
}

/** 打印错误原文（一行 `Error: ...`）+ 解析出的 code/reason/detail。 */
function printError(label, error) {
  console.log('')
  console.log(`--- ${label} ---`)
  console.log(`Error: ${error instanceof Error ? error.message : String(error)}`)
  try {
    const { body } = bodyOf(error)
    console.log(`  code=${String(body.code)} reason_code=${String(body.reason_code)}`)
    if (body.detail !== undefined) console.log(`  detail=${JSON.stringify(body.detail)}`)
  } catch {
    // 不是契约错误时不强解，原文已经打印。
  }
  console.log('')
}

/** 记下一条真实创建的行，并立刻打印 id（取证）。 */
function record(label, value) {
  const entry = {
    label,
    job_id: value.job.id,
    code: value.job.code,
    approval_id: value.rubric === null ? null : value.rubric.approval.approval_id,
  }
  created.push(entry)
  console.log(`[created] ${label}: job_id=${entry.job_id} code=${entry.code}`
    + `${entry.approval_id === null ? '' : ` approval_id=${entry.approval_id}`}`)
  return entry
}

console.log('=== S3 岗位线负例（真实库 ra_s6s7；会真写库，不删行）===')
console.log(`本次运行 code 前缀：S3N-${RUN}-`)
console.log('')

// ---------------------------------------------------------------- ① 缺标准
console.log('### ① 只建岗位、不建标准 → job_get 回报 NO_RUBRIC_AT_ALL')
const onlyJob = await call(create, { title: `负例①-无标准-${RUN}`, code: nextCode() })
if (!onlyJob.ok) {
  printError('① create（预期成功，实际失败）', onlyJob.error)
  check('① create 成功', false)
} else {
  record('① 只建岗位', onlyJob.value)
  const read = await call(get, { job_id: onlyJob.value.job.id })
  if (!read.ok) {
    printError('① job_get（预期返回 absence，实际抛错）', read.error)
    check('① job_get 返回 absence', false)
  } else {
    const code = read.value.rubric_absence === null ? null : read.value.rubric_absence.code
    console.log(`  job_get: rubric=${read.value.rubric === null ? 'null' : 'present'} rubric_absence.code=${String(code)}`)
    console.log(`  message: ${read.value.rubric_absence === null ? '' : read.value.rubric_absence.message}`)
    check('① job_get = NO_RUBRIC_AT_ALL', code === 'NO_RUBRIC_AT_ALL', `got ${String(code)}`)
  }
}

// ---------------------------------------------------------------- ② 未批准
console.log('')
console.log('### ② 建了标准但仍是 PENDING → job_get 回报 NO_APPROVED_RUBRIC')
const pending = await call(create, { title: `负例②-未批准-${RUN}`, code: nextCode(), criteria: GOOD_CRITERIA })
if (!pending.ok) {
  printError('② create（预期成功，实际失败）', pending.error)
  check('② create 成功', false)
} else {
  record('② 标准待批', pending.value)
  const read = await call(get, { job_id: pending.value.job.id })
  if (!read.ok) {
    printError('② job_get（预期返回 absence，实际抛错）', read.error)
    check('② job_get 返回 absence', false)
  } else {
    const code = read.value.rubric_absence === null ? null : read.value.rubric_absence.code
    console.log(`  job_get: rubric=${read.value.rubric === null ? 'null' : 'present'} rubric_absence.code=${String(code)}`)
    console.log(`  message: ${read.value.rubric_absence === null ? '' : read.value.rubric_absence.message}`)
    check('② job_get = NO_APPROVED_RUBRIC', code === 'NO_APPROVED_RUBRIC', `got ${String(code)}`)
  }
}

// ---------------------------------------------------------------- ③ 非法 UUID
console.log('')
console.log('### ③ 非法 UUID（不写库）')
const badDepartment = await call(create, { title: `负例③-部门-${RUN}`, department_id: 'not-a-uuid' })
if (badDepartment.ok) {
  console.log('  预期 INVALID_ARGS(ID_NOT_UUID)，实际创建成功')
  check('③ department_id=not-a-uuid 被拒', false)
} else {
  printError('③a create department_id=not-a-uuid', badDepartment.error)
  const { body } = bodyOf(badDepartment.error)
  check('③a INVALID_ARGS/ID_NOT_UUID', body.code === 'INVALID_ARGS' && body.reason_code === 'ID_NOT_UUID',
    `got ${String(body.code)}/${String(body.reason_code)}`)
}

const badJobId = await call(update, { job_id: 'job_0001', title: '负例③' })
if (badJobId.ok) {
  console.log('  预期 INVALID_ARGS(ID_NOT_UUID)，实际更新成功')
  check('③ job_id=job_0001 被拒', false)
} else {
  printError('③b update job_id=job_0001', badJobId.error)
  const { body } = bodyOf(badJobId.error)
  check('③b INVALID_ARGS/ID_NOT_UUID', body.code === 'INVALID_ARGS' && body.reason_code === 'ID_NOT_UUID',
    `got ${String(body.code)}/${String(body.reason_code)}`)
}

// ---------------------------------------------------------------- ④ 重复 code
console.log('')
console.log('### ④ 重复 code → 真 SQLSTATE 23505')
const duplicateCode = nextCode()
const firstWithCode = await call(create, { title: `负例④-首次-${RUN}`, code: duplicateCode })
if (!firstWithCode.ok) {
  printError('④ 首次 create（预期成功，实际失败）', firstWithCode.error)
  check('④ 首次 create 成功', false)
} else {
  record('④ 首次使用该 code', firstWithCode.value)
  const second = await call(create, { title: `负例④-重复-${RUN}`, code: duplicateCode })
  if (second.ok) {
    console.log('  预期 DUPLICATE_JOB_CODE，实际创建成功')
    check('④ 重复 code 被拒', false)
  } else {
    printError('④ 同一 code 再建一次', second.error)
    const { body } = bodyOf(second.error)
    const detail = body.detail ?? {}
    check('④ DUPLICATE_JOB_CODE + sqlstate 23505',
      body.code === 'INVALID_ARGS' && body.reason_code === 'DUPLICATE_JOB_CODE'
        && detail.sqlstate === '23505' && detail.constraint === 'uq_job_code',
      `got ${String(body.code)}/${String(body.reason_code)} sqlstate=${String(detail.sqlstate)} constraint=${String(detail.constraint)}`)
  }
}

// ---------------------------------------------------------------- ⑤ 权重和 0.9
console.log('')
console.log('### ⑤ weight Σ=0.9 → INVALID_ARGS/RUBRIC_INVALID(WEIGHT_SUM)')
const badWeights = await call(create, {
  title: `负例⑤-权重-${RUN}`,
  code: nextCode(),
  criteria: [
    { key: 'a', label: 'A', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
    { key: 'b', label: 'B', kind: 'MUST_HAVE', weight: 0.4, field: 'timeline.covered_months_closed', operator: 'GTE', value: 36 },
  ],
})
if (badWeights.ok) {
  console.log('  预期 RUBRIC_INVALID(WEIGHT_SUM)，实际创建成功')
  check('⑤ 权重和 0.9 被拒', false)
} else {
  printError('⑤ weight Σ=0.9', badWeights.error)
  const { body } = bodyOf(badWeights.error)
  const violations = Array.isArray(body.detail?.violations) ? body.detail.violations : []
  const reasons = violations.map((violation) => violation.reason_code)
  check('⑤ RUBRIC_INVALID + WEIGHT_SUM',
    body.code === 'INVALID_ARGS' && body.reason_code === 'RUBRIC_INVALID' && reasons.includes('WEIGHT_SUM'),
    `got ${String(body.code)}/${String(body.reason_code)} violations=${JSON.stringify(reasons)}`)
}

// ---------------------------------------------------------------- ⑥ 重复批准
console.log('')
console.log('### ⑥ 同一 approval 批两次 → APPROVAL_NOT_PENDING')
const forApproval = await call(create, { title: `负例⑥-重复批准-${RUN}`, code: nextCode(), criteria: GOOD_CRITERIA })
if (!forApproval.ok) {
  printError('⑥ create（预期成功，实际失败）', forApproval.error)
  check('⑥ create 成功', false)
} else {
  const entry = record('⑥ 待批标准', forApproval.value)
  const first = await decide({ approval_id: entry.approval_id, decision: 'APPROVE' })
  if (!first.ok) {
    printError('⑥ 第一次批准（预期成功，实际失败）', first.error)
    check('⑥ 第一次批准成功', false)
  } else {
    console.log(`  第一次批准：status=${first.value.status} decided_by=${first.value.decided_by_actor_id}`)
    const second = await decide({ approval_id: entry.approval_id, decision: 'APPROVE' })
    if (second.ok) {
      console.log('  预期 APPROVAL_NOT_PENDING，实际第二次也成功')
      check('⑥ 重复批准被拒', false)
    } else {
      printError('⑥ 同一 approval 再批一次', second.error)
      const { body } = bodyOf(second.error)
      check('⑥ INVALID_ARGS/APPROVAL_NOT_PENDING',
        body.code === 'INVALID_ARGS' && body.reason_code === 'APPROVAL_NOT_PENDING',
        `got ${String(body.code)}/${String(body.reason_code)}`)
    }
  }
}

// ---------------------------------------------------------------- ⑦ 拒绝缺 reason
console.log('')
console.log('### ⑦ REJECT 缺 reason → INVALID_ARGS/REASON_REQUIRED')
const forReject = await call(create, { title: `负例⑦-拒绝缺理由-${RUN}`, code: nextCode(), criteria: GOOD_CRITERIA })
if (!forReject.ok) {
  printError('⑦ create（预期成功，实际失败）', forReject.error)
  check('⑦ create 成功', false)
} else {
  const entry = record('⑦ 待批标准（拒绝缺理由）', forReject.value)
  const rejected = await decide({ approval_id: entry.approval_id, decision: 'REJECT' })
  if (rejected.ok) {
    console.log('  预期 REASON_REQUIRED，实际拒绝成功')
    check('⑦ 拒绝缺 reason 被拒', false)
  } else {
    printError('⑦ REJECT 不给 reason', rejected.error)
    const { body } = bodyOf(rejected.error)
    check('⑦ INVALID_ARGS/REASON_REQUIRED',
      body.code === 'INVALID_ARGS' && body.reason_code === 'REASON_REQUIRED',
      `got ${String(body.code)}/${String(body.reason_code)}`)
  }
}

// ---------------------------------------------------------------- 汇总
console.log('')
console.log('=== 本次真实写入的行（历史事实，禁删；仅供人工取证/清理决策）===')
if (created.length === 0) {
  console.log('  (none)')
} else {
  for (const entry of created) {
    console.log(`  ${entry.label}  job_id=${entry.job_id}  code=${entry.code}`
      + `${entry.approval_id === null ? '' : `  approval_id=${entry.approval_id}`}`)
  }
}
console.log('')
console.log(`=== result: ${created.length} job(s) created, ${failures.length} check(s) failed ===`)
if (failures.length > 0) {
  for (const label of failures) console.error(`FAILED: ${label}`)
  process.exit(1)
}
console.log('ALL NEGATIVES MATCHED THE CONTRACT')
