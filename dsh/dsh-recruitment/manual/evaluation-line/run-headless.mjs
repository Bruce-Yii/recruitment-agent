// S10 评价线 · 真实 headless 驱动（取证脚本，不是产品运行时）。
//
// 做什么：起一个**真实的** DSH headless 会话（`dsh --profile <p> --patch <overlay> "<目标>"`），
// 把该会话的 `tool/call` + `tool/result` 原文从会话日志里抽出来存证。
//   * agent loop / 工具注册表 / JSON Schema 校验 / 会话日志 全部是 DSH 自己的；
//   * 唯一非产品的东西是**注册点**：`manual/evaluation-line/plugin-eval.mjs`
//     通过 `--patch` 的 insert 插进层栈（产品入口 `src/index.ts` 由 W0 独占，本轮不许改）。
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/evaluation-line/run-headless.mjs --profile rec-eval-x --overlay patch/overlay-x.yml `
//        --label x-submit --goal "……"
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expandGoalTemplates, hasGoalTemplates, readPinnedRubric } from './pinned-rubric.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')
const REPO = resolve(PLUGIN_DIR, '..', '..')
const DSH_HOME = process.env.DSH_HOME ?? 'D:/12412/dsh-home'
const PYTHON = process.env.RECRUITMENT_PYTHON ?? 'D:/Python3.12.9/python.exe'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const profile = option('--profile')
// overlay 解析成绝对路径：spawn 的 cwd 是仓库根，而调用方通常从插件目录给相对路径。
const overlayArg = option('--overlay')
const overlay = overlayArg === undefined ? undefined : resolve(overlayArg)
const label = option('--label', `run-${Date.now()}`)
// --goal-file 让目标文本（含大段 JSON 与中文）从文件读，避免 PowerShell 引号/换行把参数弄坏。
const goalFile = option('--goal-file')
const goal = goalFile === undefined
  ? option('--goal')
  : readFileSync(resolve(goalFile), 'utf8')
if (profile === undefined || overlay === undefined || goal === undefined) {
  console.error('usage: run-headless.mjs --profile <p> --overlay <overlay.yml> --label <label> (--goal "<text>" | --goal-file <path>)')
  process.exit(2)
}

// goal 里的 `{{...}}` 模板（例如 scorecard items 的维度键）在**运行时**从库里读申请钉住的
// rubric 真实 dimensions 展开——goal 文件不再硬编码任何版本键（D-110 时代的演示夹具已换 pin v2）。
// 展开失败 = fail-closed：绝不把带 `{{...}}` 的半成品目标发给模型。
let resolvedGoal = goal
if (hasGoalTemplates(goal)) {
  try {
    const rubric = await readPinnedRubric()
    resolvedGoal = expandGoalTemplates(goal, rubric)
    console.log(`[run] goal templates expanded from DB: rubric v${rubric.version_no} `
      + `(${rubric.rubric_version_id}) keys=${['transcript_basis', ...rubric.dimensions.map((d) => d.key)].join(',')}`)
  } catch (error) {
    console.error(`[run] goal 模板展开失败（fail-closed，不发送未展开的 {{...}}）：${error?.message ?? String(error)}`)
    process.exit(2)
  }
}

const evidenceDir = join(HERE, 'evidence', label)
mkdirSync(evidenceDir, { recursive: true })

const startedAt = Date.now()
console.log(`[run] profile=${profile} overlay=${overlay} label=${label}`)
console.log(`[run] goal=${resolvedGoal}`)

const started = spawnSync(
  'dsh',
  ['--profile', profile, '--patch', overlay, resolvedGoal],
  { cwd: REPO, env: process.env, encoding: 'utf8', timeout: 900_000, shell: true },
)

const stdout = started.stdout ?? ''
const stderr = started.stderr ?? ''
writeFileSync(join(evidenceDir, 'dsh-stdout.txt'), stdout, 'utf8')
writeFileSync(join(evidenceDir, 'dsh-stderr.txt'), stderr, 'utf8')
console.log(`[run] exit=${started.status}`)

/** 递归找出 `startedAt` 之后被写过的会话日志。 */
function findSessionLogs(dir) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.name === 'session.v3.jsonl.zstd') {
        const mtime = statSync(path).mtimeMs
        if (mtime >= startedAt - 2000) found.push({ path, mtime })
      }
    }
  }
  walk(dir)
  return found.sort((a, b) => b.mtime - a.mtime)
}

const logs = findSessionLogs(join(DSH_HOME, 'sessions'))
if (logs.length === 0) {
  console.error('[run] 没找到本次会话日志；无法抽取 tool/call 与 tool/result')
  process.exitCode = 1
} else {
  const newest = logs[0].path
  writeFileSync(join(evidenceDir, 'session-path.txt'), `${newest}\n`, 'utf8')
  console.log(`[run] session log: ${newest}`)
  const extracted = spawnSync(PYTHON, [join(PLUGIN_DIR, 'manual', 'extract-session-tools.py'), newest], {
    encoding: 'utf8', timeout: 120_000,
  })
  const trace = extracted.stdout ?? ''
  writeFileSync(join(evidenceDir, 'tool-trace.txt'), trace, 'utf8')
  if ((extracted.stderr ?? '') !== '') {
    writeFileSync(join(evidenceDir, 'extract-stderr.txt'), extracted.stderr, 'utf8')
  }
  console.log('===== tool/call + tool/result（原文，PII 已打码）=====')
  console.log(trace)
}

// 目标文件也留一份，证据自解释（展开后的版本；原始模板另存 goal-template.txt）。
writeFileSync(join(evidenceDir, 'goal.txt'), `${resolvedGoal}\n`, 'utf8')
if (resolvedGoal !== goal) writeFileSync(join(evidenceDir, 'goal-template.txt'), `${goal}\n`, 'utf8')
if (existsSync(join(evidenceDir, 'tool-trace.txt'))) {
  const trace = readFileSync(join(evidenceDir, 'tool-trace.txt'), 'utf8')
  const summary = {
    label,
    profile,
    overlay: resolve(overlay),
    exit: started.status,
    tool_calls: (trace.match(/--- tool\/call #/g) ?? []).length,
    tool_results: (trace.match(/--- tool\/result #/g) ?? []).length,
  }
  writeFileSync(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`[run] tool_calls=${summary.tool_calls} tool_results=${summary.tool_results}`)
}
