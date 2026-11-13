// **人类**批准动作的 CLI：`recruitment_job_create` 只写 PENDING，批准必须由人来做。
//
// 为什么单独一个脚本：`decideRubricApproval()` 不是模型工具（SPEC §1 第 1 条、
// APP-07 / docs/20 §2 的人类闸门不可由模型冒充）。同一个函数以后由 W0 的 Web
// 按钮复用，所以这里只做参数解析 + 真实调用 + 打印 JSON，不复制业务逻辑。
//
// 用法（PowerShell，在 dsh/dsh-recruitment 下）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/job-line/approve-rubric.mjs <approval_id>
//   node manual/job-line/approve-rubric.mjs <approval_id> --reject --reason "标准与岗位不符"
//
// 输出：批准/拒绝成功的 value（JSON）；失败时打印 `Error: <CODE>: <json>` 原文并 exit 1。
// 成功的批准是**已提交**的事实（历史事实禁删）；拒绝必须有 reason（理由进 approval.reason）。
import { decideRubricApproval } from '../../src/tools/job-create.ts'
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

/** 解析 `[--reject] [--reason <text>]` 与位置参数 approval_id。 */
function parseArgv(argv) {
  let approvalId
  let reject = false
  let reason
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--reject') {
      reject = true
    } else if (arg === '--reason') {
      reason = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`)
    } else if (approvalId === undefined) {
      approvalId = arg
    } else {
      throw new Error(`unexpected argument ${arg}`)
    }
  }
  if (approvalId === undefined) throw new Error('usage: approve-rubric.mjs <approval_id> [--reject --reason <text>]')
  return { approvalId, decision: reject ? 'REJECT' : 'APPROVE', reason }
}

let input
try {
  input = parseArgv(process.argv.slice(2))
} catch (error) {
  console.error(`Error: ${error.message}`)
  process.exit(2)
}

try {
  const value = await decideRubricApproval(
    database.resolved,
    { approval_id: input.approvalId, decision: input.decision, reason: input.reason },
  )
  // 原样打印函数返回：这就是"人做了决定"的可取证结果（含 hash / record_version）。
  console.log(JSON.stringify(value, null, 2))
  console.log('')
  console.log(`approval ${value.approval_id} -> ${value.status} by ${value.decided_by_actor_id} at ${value.decided_at}`)
  console.log(`rubric version ${value.rubric_version_no} of job ${value.job_id}; hash ${value.canonical_payload_hash}`)
} catch (error) {
  console.error(`Error: ${error?.message ?? String(error)}`)
  process.exit(1)
}
