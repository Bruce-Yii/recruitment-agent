// 手工联调（不是单测）：把 `recruitment_job_get` 对着本地 PG 真跑一遍。
//
// 为什么放在 `manual/` 而不是 `test/`：`node --test` 会把 `test/` 下的文件当测试加载，
// 而这个脚本要连库、依赖 R7 的演示数据；缺库时它应该**明确报错**，不是静默 skip。
//
// 用法（PowerShell，在 dsh/dsh-recruitment 下）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/job-get-live.mjs [job_uuid]
//
// 输出是 `tool/result` 的原文（value + render），供取证用；不含任何候选人个资。
import { createJobGetTool } from '../src/tools/job-get.ts'
import { resolveDatabaseConfig } from '../src/db/pool.ts'

const DEMO_JOB = '11111111-1111-4111-8111-000000000401'
const JOB_ID = process.argv[2] ?? DEMO_JOB

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

const tool = createJobGetTool(database.resolved)
const signal = new AbortController().signal

async function call(args) {
  try {
    const value = await tool.execute(args, { signal })
    return { ok: true, value, text: tool.output.render(args, value).map((block) => block.text).join('\n') }
  } catch (error) {
    return { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`, code: error?.code }
  }
}

function show(label, result) {
  console.log(`=== ${label} ===`)
  if (result.ok) {
    console.log(result.text)
    console.log('--- value (JSON) ---')
    console.log(JSON.stringify(result.value, null, 2))
  } else {
    console.log(result.error)
  }
  console.log('')
  return result
}

const positive = show(`job_get ${JOB_ID} (current rubric)`, await call({ job_id: JOB_ID }))
if (!positive.ok) process.exit(1)

show('job_get 指定 rubric_version_no=1', await call({ job_id: JOB_ID, rubric_version_no: 1 }))
show('job_get 指定 rubric_version_id', await call({ job_id: JOB_ID, rubric_version_id: '11111111-1111-4111-8111-000000000403' }))
show('job_get as_of=2026-11-13T00:00:00+08:00', await call({ job_id: JOB_ID, as_of: '2026-11-13T00:00:00+08:00' }))

show('负例：未知 UUID -> NOT_FOUND', await call({ job_id: '00000000-0000-4000-8000-000000000000' }))
show('负例：job_0001（stub id）-> INVALID_ARGS(ID_NOT_UUID)', await call({ job_id: 'job_0001' }))
show('负例：不存在的版本号 -> NOT_FOUND', await call({ job_id: JOB_ID, rubric_version_no: 9 }))
show('负例：两个版本参数同时给 -> INVALID_ARGS(MUTUALLY_EXCLUSIVE)',
  await call({ job_id: JOB_ID, rubric_version_no: 1, rubric_version_id: '11111111-1111-4111-8111-000000000403' }))
show('负例：未来 as_of -> INVALID_ARGS(AS_OF_IN_FUTURE)',
  await call({ job_id: JOB_ID, as_of: '2099-01-01T00:00:00+08:00' }))
show('负例：模型传入 actor_id -> INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)',
  await call({ job_id: JOB_ID, actor_id: '11111111-1111-4111-8111-000000000101' }))
