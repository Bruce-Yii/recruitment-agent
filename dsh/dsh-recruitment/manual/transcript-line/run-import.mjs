// S9 线 1 · 人工导入转写（真实工具调用 + 真库写入 + tool/result 原文）。
//
// 这一步就是验收里说的“人工粘贴/上传转写文本”：文本来自本地 .txt（人工提供），
// 工具把**原文逐字节**落进 transcript_artifact（+ transcript_segment + interview_record）。
//
// 标签口径（不许漂）：
//   content 是**合成演示文本**，不是任何平台的真实导出 → source_kind='DEMO_SAMPLE'
//   → provenance=FIXTURE / trigger=MANUAL / connection=NOT_CONNECTED
// 想得到 provenance=LIVE，必须 source_kind='PLATFORM_EXPORT' 且给真实导出文件名
//（本机没有飞书授权，所以本轮**不跑**那条路径；跑它才叫用 Fixture 冒充 LIVE）。
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/transcript-line/run-import.mjs
//   node manual/transcript-line/run-import.mjs --revision   # 改一个字再导入，演示 TR-U7 新 revision
import { readFile, writeFile, mkdir } from 'node:fs/promises'

import { createTranscriptImportTool } from '../../src/tools/transcript-import.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const HERE = new URL('./', import.meta.url)
const FIXTURE = new URL('./fixtures/demo-interview-transcript.txt', import.meta.url)
const EVIDENCE = new URL('./evidence/', import.meta.url)
const REVISION_MODE = process.argv.includes('--revision')

function databaseConfig() {
  const { resolved, issues } = resolveDatabaseConfig({
    host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
    user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
    database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
    tenant_id: '11111111-1111-4111-8111-000000000001',
    actor_id: '11111111-1111-4111-8111-000000000103',
  }, process.env)
  if (resolved === null) {
    console.error(`[import] 数据库配置不完整：${issues.join('; ')}`)
    process.exit(2)
  }
  return resolved
}

/** 从 seed 证据读 interview_id；没有就按演示岗位业务键查一次（只读）。 */
async function resolveInterviewId() {
  try {
    const seed = JSON.parse(await readFile(new URL('./evidence/seed.json', HERE), 'utf8'))
    if (typeof seed.interview_id === 'string') return { interviewId: seed.interview_id, from: 'evidence/seed.json' }
  } catch {
    // 继续按业务键查
  }
  const pg = (await import('pg')).default
  const cfg = databaseConfig()
  const pool = new pg.Pool({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database,
    password: cfg.password, max: 1,
  })
  try {
    const { rows } = await pool.query(
      `select i.id from recruitment.interview i
         join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
         join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
        where i.tenant_id = $1 and j.code = 'S9-TR-DEMO'
        order by i.created_at desc limit 1`, [cfg.tenant_id],
    )
    if (rows[0] === undefined) throw new Error('找不到演示面试；先跑 node manual/transcript-line/seed-demo.mjs')
    return { interviewId: rows[0].id, from: 'business key S9-TR-DEMO' }
  } finally {
    await pool.end()
  }
}

const cfg = databaseConfig()
const { interviewId, from } = await resolveInterviewId()
const baseText = await readFile(FIXTURE, 'utf8')
// revision 演示：追加一行**合成**补录说明（内容变了 → 新 revision；旧行不动）。
const content = REVISION_MODE
  ? `${baseText}[补录 00:58] 面试官 李工：补充说明，本轮记录为合成演示文本，仅用于验证同一产物修订时新增 revision 而不是覆盖原文。\n`
  : baseText

const tool = createTranscriptImportTool(cfg)
const args = {
  interview_id: interviewId,
  content,
  source_kind: 'DEMO_SAMPLE',
  language: 'zh',
  note: REVISION_MODE ? '手工联调：修订导入（合成演示文本）' : '手工联调：首次导入（合成演示文本）',
}

console.log('=== tool ===')
console.log(tool.name)
console.log('=== tool/request ===')
console.log(JSON.stringify({ ...args, content: `<${content.length} chars omitted>` }, null, 2))
console.log(`(interview_id 来源：${from}；content 来自 manual/transcript-line/fixtures/demo-interview-transcript.txt${REVISION_MODE ? ' + 补录行' : ''})`)
console.log('=== tool/result ===')

let value
try {
  value = await tool.execute(args, { signal: new AbortController().signal })
} catch (error) {
  console.error(`${error?.code ?? error?.name}: ${error?.message ?? String(error)}`)
  process.exit(1)
}
console.log(JSON.stringify(value, null, 2))
console.log('=== render ===')
console.log(tool.output.render(args, value).map((block) => block.text).join('\n'))

await mkdir(EVIDENCE, { recursive: true })
const stamp = new Date().toISOString().replaceAll(':', '-')
const out = new URL(`./import-result${REVISION_MODE ? '-revision' : ''}-${stamp}.json`, EVIDENCE)
await writeFile(out, JSON.stringify(value, null, 2), 'utf8')
console.log(`[import] tool/result 已写入 ${out.pathname}`)
