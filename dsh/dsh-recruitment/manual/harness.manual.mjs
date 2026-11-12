// 单元级验收 harness（不属于插件运行时；package.json 的 files 不含 manual/ 与 test/）。
//
// 为什么在 `manual/` 而不是 `test/`：`node --test`（包根）会把 `test/` 目录下的**所有**
// .mjs 当成测试文件跑（Node 的默认发现规则里就有 `**/test/**/*.{mjs,js,cjs}`，改文件名躲不掉），
// 而本文件 ① 需要 DSH_HOME 里的 profiles 模块 ② apply 时没有传 config，一调用就抛
// NOT_CONFIGURED。放到非 test 目录后 Node 不再发现它（D-32 附的清理）。
// 要跑它请显式执行：`node manual/harness.manual.mjs`。
//
// 它做四件事，全部基于本机 DSH 安装里的真实模块，不重写任何 DSH 逻辑：
//   A 真实注册：用 cordis Context + @deepseek-ai/dsh-tools 的 ToolsService 挂载本插件，
//     读 ctx.tools.schemas() —— 这是宿主真正会发给模型的投影。
//   B 正例调用：取 ctx.tools.get(name) 拿到的定义，执行 execute()，再用官方
//     validateJsonSchemaValue() 校验返回值是否符合 output.schema，最后跑 render()。
//   C 负向测试：未知参数 / 类型不符 / 缺必填 / 未知 id，捕获真实错误。
//   D 交叉验证：把同一个坏入参交给官方 validateJsonSchemaValue(paramtersSchema)，
//     证明「我们自己生成的 parameters schema 本身就是封闭的」。
//   E 只读静态自检：扫描 src/ 确认没有 fs / net / DB / 写入 / 子进程调用
//     （白名单只有 src/tools/converter.ts，理由见 §E 的扫描规则）。
//
// 明确边界：这是单元级调用，**不是真实模型会话**（没有 LLM 参与，没有执行策略流水线，
// 安装包里也没有发布 lib/pipeline.js）。真实会话调用见 CONTRACT.md §7。

import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN_DIR = resolve(TEST_DIR, '..')
const DSH_HOME = process.env.DSH_HOME ?? 'D:/12412/dsh-home'
const PROFILE_MODULES = join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai')
const asUrl = (path) => pathToFileURL(path).href

const { Context, Service } = await import(asUrl(join(PROFILE_MODULES, 'cordis/lib/index.js')))
const toolsModule = await import(asUrl(join(PROFILE_MODULES, 'dsh-tools/lib/index.js')))

const failures = []
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** ToolsService 只 inject systemPrompt；这里给一个最小替身，避免拉起整个提示词栈。 */
class StubSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
    this.sections = []
  }
  tools(callback) {
    this.sections.push(callback)
    return () => {}
  }
  section() {
    return () => {}
  }
}

console.log('=== A 真实注册表投影 ===')
const ctx = new Context()
ctx.plugin(StubSystemPrompt)
ctx.plugin(toolsModule.default)
await new Promise((done) => setTimeout(done, 200))

const plugin = await import(asUrl(join(PLUGIN_DIR, 'src/index.ts')))
console.log(`plugin module: name=${plugin.name} inject=${JSON.stringify(plugin.inject)} apply=${typeof plugin.apply}`)
await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
await new Promise((done) => setTimeout(done, 200))

const schemas = ctx.tools.schemas()
console.log(`ctx.tools.schemas() -> ${schemas.length} tool(s): ${schemas.map((s) => s.name).join(', ')}`)
check('恰好注册 3 个工具', schemas.length === 3, `got ${schemas.length}`)
check(
  '工具名与契约一致',
  JSON.stringify(schemas.map((s) => s.name)) === JSON.stringify([
    'recruitment_resume_read',
    'recruitment_candidate_get',
    'recruitment_job_get',
  ]),
)

for (const schema of schemas) {
  // 注册表在 register() 时会 assertSupportedJsonSchema(output.schema)；这里再证明
  // parameters 也在官方支持子集内（否则提供商/校验器会拒）。
  let schemaError
  try {
    toolsModule.assertSupportedJsonSchema(schema.parameters)
  } catch (error) {
    schemaError = error
  }
  const closed = schema.parameters.additionalProperties === false
  console.log(`  ${schema.name}: parameters.additionalProperties=${String(schema.parameters.additionalProperties)}`
    + `, 官方 assertSupportedJsonSchema=${schemaError === undefined ? 'ok' : `抛出 ${schemaError.message}`}`)
  check(`${schema.name} 的 parameters 被官方 schema 校验器接受`, schemaError === undefined)
  check(`${schema.name} 的 parameters 显式封闭（拒绝未知字段）`, closed)
}

console.log('')
console.log('=== B 正例调用（真实 execute + 官方 output.schema 校验 + render） ===')
const happyPath = [
  { name: 'recruitment_resume_read', args: { resume_id: 'resume_0001', max_blocks: 3 } },
  { name: 'recruitment_resume_read', args: { resume_id: 'resume_0002', block_types: ['contact'] } },
  { name: 'recruitment_candidate_get', args: { candidate_id: 'candidate_0001' } },
  { name: 'recruitment_candidate_get', args: { candidate_id: 'candidate_0001', include_contacts: true } },
  { name: 'recruitment_job_get', args: { job_id: 'job_0001' } },
  { name: 'recruitment_job_get', args: { job_id: 'job_0001', rubric_version: 'v2' } },
]
const outputs = []
for (const call of happyPath) {
  const definition = ctx.tools.get(call.name)
  check(`${call.name}: 定义可见`, definition !== undefined)
  if (definition === undefined) continue
  const value = await definition.execute(call.args, undefined)
  const violations = toolsModule.validateJsonSchemaValue(definition.output.schema, value, '')
  const content = definition.output.render(call.args, value)
  outputs.push({ name: call.name, args: call.args, value, violations, content })
  check(`${call.name} ${JSON.stringify(call.args)} -> output.schema 零违反`, violations.length === 0,
    violations.join('; '))
  check(`${call.name} render 产出非空文本`, content.length === 1 && content[0].text.length > 0)
  console.log(`  --- ${call.name} ${JSON.stringify(call.args)} ---`)
  console.log(content[0].text.split('\n').map((line) => `  | ${line}`).join('\n'))
}

console.log('')
console.log('=== C 负向测试：传未知参数 / 类型不符 / 缺必填 / 未知 id ===')
const negatives = [
  { name: 'recruitment_resume_read', args: { resume_id: 'resume_0001', bogus: 1 }, expect: 'INVALID_ARGS' },
  { name: 'recruitment_job_get', args: { job_id: 'job_0001', unknown_flag: true }, expect: 'INVALID_ARGS' },
  { name: 'recruitment_resume_read', args: { resume_id: 'resume_0001', max_blocks: 'ten' }, expect: 'INVALID_ARGS' },
  { name: 'recruitment_candidate_get', args: {}, expect: 'INVALID_ARGS' },
  { name: 'recruitment_job_get', args: { job_id: 'job_9999' }, expect: 'NOT_FOUND' },
  { name: 'recruitment_job_get', args: { job_id: 'job_0001', rubric_version: 'v9' }, expect: 'NOT_FOUND' },
]
for (const negative of negatives) {
  const definition = ctx.tools.get(negative.name)
  let error
  try {
    await definition.execute(negative.args, undefined)
  } catch (caught) {
    error = caught
  }
  check(`${negative.name} ${JSON.stringify(negative.args)} 被拒绝`, error !== undefined)
  if (error !== undefined) {
    const codeOk = error.code === negative.expect && error.message.startsWith(`${negative.expect}: `)
    check(`${negative.name} 错误码为 ${negative.expect}`, codeOk, `got ${error.code}: ${error.message}`)
    console.log(`  ! ${negative.name} ${JSON.stringify(negative.args)}`)
    console.log(`  !   ${error.name}: ${error.message}`)
  }
}

console.log('')
console.log('=== D 交叉验证：官方校验器用同一份 parameters schema 也拒绝同一入参 ===')
for (const negative of negatives.slice(0, 4)) {
  const definition = ctx.tools.get(negative.name)
  const violations = toolsModule.validateJsonSchemaValue(definition.parameters, negative.args, '')
  check(`${negative.name} 官方 schema 校验拒绝 ${JSON.stringify(negative.args)}`, violations.length > 0)
  console.log(`  ~ ${negative.name} ${JSON.stringify(negative.args)} -> ${violations.join('; ')}`)
}

console.log('')
console.log('=== E 只读静态自检：src/ 里没有 fs / 子进程 / 网络 / 写路径 ===')
// 扫描规则：src/ 下的 .ts 文件不得命中下面任何模式，**除非**在 ALLOWED_SOURCE_HITS 里。
// 白名单（只有一条，且已写进裁定台账 D-32 附）：
//   src/tools/converter.ts 是**唯一允许起子进程的文件**，它调用本地 Python 读取器
//   （converter/ 的 PyMuPDF 实现）拿结构化 JSON——这是复用边界，不是通用后门；
//   它同时需要 node:fs 做「路径必须存在 + realpath」的 fail-closed 校验，故一并放行。
// 除它之外，任何文件出现 child_process / node:fs 都是违规，必须拆到 converter.ts 或去掉。
const ALLOWED_SOURCE_HITS = new Map([
  ['src/tools/converter.ts', new Set(['node:fs', '子进程'])],
])
const forbidden = [
  ['node:fs', /node:fs/],
  ['fs', /from\s+'fs'|require\(\s*'fs'\s*\)/],
  ['node:net / http / https', /node:(net|http|https)/],
  ['pg / 数据库驱动', /from\s+'(pg|mysql2?|sqlite3|better-sqlite3|mongodb)'/],
  ['fetch( / XMLHttpRequest', /\bfetch\s*\(|XMLHttpRequest/],
  ['写入调用', /writeFile|appendFile|createWriteStream|\bunlink\(|\brm\(|\bmkdir\(/],
  ['SQL 写语句', /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE)\b/i],
  ['子进程', /child_process|execSync|spawnSync/],
]
const sourceFiles = []
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.name.endsWith('.ts')) sourceFiles.push(path)
  }
}
await walk(join(PLUGIN_DIR, 'src'))
const relativeOf = (path) => path.slice(PLUGIN_DIR.length + 1).replaceAll('\\', '/')
console.log(`扫描 ${sourceFiles.length} 个源文件：${sourceFiles.map(relativeOf).join(', ')}`)
for (const [label, pattern] of forbidden) {
  const hits = []
  for (const path of sourceFiles) {
    const text = await readFile(path, 'utf8')
    if (!pattern.test(text)) continue
    const relative = relativeOf(path)
    const allowed = ALLOWED_SOURCE_HITS.get(relative)
    if (allowed !== undefined && allowed.has(label)) {
      console.log(`  (白名单) ${relative} 命中「${label}」：converter.ts 调用本地 Python 读取器，允许`)
      continue
    }
    hits.push(relative)
  }
  check(`src/ 无 ${label}`, hits.length === 0, hits.join(', '))
}

console.log('')
console.log('=== 汇总 ===')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED (${failures.length}): ${failures.join(' | ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
