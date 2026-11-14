// 假 Lark CLI：只为 `lark-cli-transport` 的测试提供一个**真实子进程**。
//
// 它不是 lark-cli，也不发任何网络请求：按 `FAKE_LARK_CLI_SCENARIO` 回放固定
// 行为。**行为形态照 2026-11-14 实测的真实 CLI**：
//   * argv：`minutes +detail --as user --minute-tokens <tokens> --transcript --output-dir <dir>`
//   * stdout：只给 JSON 元数据 `{ok, identity, data:{minutes:[{minute_token, artifacts:{transcript_file}}]}, meta}`
//   * 正文：**写进 `--output-dir` 下的相对路径文件**，不出现在 stdout
//   * 进度日志：写 stderr（真实 CLI 就是这样）
// 它产出的任何字节都只属于 FIXTURE 语料，**不得**被标成 LIVE（transport 默认
// `platform_channel=false`，回读 transport 恒 FIXTURE）。
//
// 场景（environment FAKE_LARK_CLI_SCENARIO）：
//   ok（默认）三行正文；single 两行；generating ok=false+2091003；
//   generating-stderr 退出 3 + stderr 里 2091003；nonzero 退出 3 + 未知码；
//   timeout 长时间不返回；leak 退出 5 且 stderr 里带正文（测 R7 脱敏）；
//   badenvelope 非 JSON；missingfile 信封说写了但文件不存在；emptyfile 空文件；
//   micromatch 回显别的 minute_token；noartifact 缺 artifacts.transcript_file；
//   help 打印真实 `--help`（含必需 flag）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const argv = process.argv.slice(2)
const scenario = process.env.FAKE_LARK_CLI_SCENARIO ?? 'ok'

/** 一段**假**的面试正文（合成语料，不是任何真实候选人资料）。 */
const LINE_1 = '面试官：请先介绍一下你最近三年做过的项目，重点讲你负责的部分和遇到的困难。'
const LINE_2 = '候选人：我主要负责订单链路的稳定性，把超时率从百分之三降到千分之二，做法是加熔断和分级降级。'
const LINE_3 = '面试官：如果线上突然大量超时，你会先看哪些指标，怎么判断是依赖问题还是自身问题？'

/** 取 flag 的值（简单实现；测试 argv 不含引号）。 */
function flagValue(name) {
  const index = argv.indexOf(name)
  return index >= 0 ? (argv[index + 1] ?? '') : ''
}

/** 只写 stdout 的 JSON 信封（单行，避免测试断言受排版影响）。 */
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exit(0)
}

/** 写 stderr + 非零退出。 */
function fail(code, stderr) {
  process.stderr.write(`${stderr}\n`)
  process.exit(code)
}

// `--help`：与真实 CLI 一样只打印帮助、不写文件、不要 token。
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    [
      'Query minute details with selective artifact flags (summary, todo, chapter, transcript, keyword)',
      '',
      'Usage:',
      '  lark-cli minutes +detail [flags]',
      '',
      'Flags:',
      '      --as string              identity type: user',
      '      --chapter                include chapters',
      '      --format string          output format: json (default) | pretty | table | ndjson | csv (default "json")',
      '  -h, --help                   help for +detail',
      '      --keyword                include keywords',
      '      --minute-tokens string   minute tokens, comma-separated for batch',
      '      --output-dir string      output directory for transcript files (default: ./minutes/{minute_token}/)',
      '      --overwrite              overwrite existing transcript files',
      '      --summary                include summaries',
      '      --todo                   include todos',
      '      --transcript             include transcript (saved to file)',
      '',
    ].join('\n'),
  )
  process.exit(0)
}

const tokens = flagValue('--minute-tokens')
  .split(',')
  .map((token) => token.trim())
  .filter((token) => token !== '')
const outputDir = flagValue('--output-dir') || 'minutes'
const workdir = process.cwd()

/** 把正文写进 `<cwd>/<output-dir>/artifact-synthetic-<token>/transcript.txt`，返回相对 cwd 的路径。 */
function writeTranscript(token, text) {
  const absolute = join(workdir, outputDir, `artifact-synthetic-${token}`, 'transcript.txt')
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text, 'utf8')
  // 真实 CLI 在 Windows 上给的是反斜杠相对路径；transports 两种分隔符都认。
  return relative(workdir, absolute).replace(/\//g, '\\')
}

/** 造一个真实形态的信封（stdout 只有元数据，没有正文）。 */
function detailEnvelope(entries) {
  return {
    ok: true,
    identity: 'user',
    data: { minutes: entries },
    meta: { count: entries.length },
  }
}

/** 一个 minute 条目（只含元数据 + 落盘路径）。 */
function minuteEntry(token, transcriptFile, overrides = {}) {
  return {
    minute_token: token,
    title: 'synthetic',
    note_id: '',
    artifacts: transcriptFile === null ? {} : { transcript_file: transcriptFile },
    ...overrides,
  }
}

if (scenario === 'timeout') {
  // 永不返回：让传输层的超时逻辑杀掉本进程。
  setTimeout(() => {}, 60_000)
} else if (scenario === 'badenvelope') {
  // 非 JSON：传输层必须整段丢弃，不回显内容。
  process.stdout.write(`not json at all：${LINE_1}\n`)
  process.exit(0)
} else if (scenario === 'generating') {
  send({ ok: false, error: { code: 2091003, message: 'the minute is still generating' } })
} else if (scenario === 'generating-stderr') {
  fail(7, JSON.stringify({ ok: false, error: { code: 2091003, message: 'still generating' } }))
} else if (scenario === 'nonzero') {
  fail(3, JSON.stringify({ ok: false, error: { code: 424242, message: 'unknown failure' } }))
} else if (scenario === 'leak') {
  // 退出码 5 + 把「正文」塞进 stderr：传输层必须脱敏后再外传（R7）。
  fail(5, `cli crashed while rendering transcript: ${LINE_1}${LINE_2}`)
} else if (tokens.length === 0) {
  // 真实 CLI 缺 token 会报错；这里模拟成非零退出 + 未知码。
  fail(2, JSON.stringify({ ok: false, error: { code: 400, message: 'minute_tokens is required' } }))
} else if (scenario === 'micromatch') {
  const wrong = 'mt_someone_else'
  process.stderr.write(`[minutes +detail] querying minute_token=${tokens[0]} ...\n`)
  send(detailEnvelope([minuteEntry(wrong, writeTranscript(wrong, LINE_1))]))
} else if (scenario === 'missingfile') {
  const token = tokens[0]
  process.stderr.write(`[minutes +detail] writing transcript: ${outputDir}\\artifact-synthetic-${token}\\transcript.txt\n`)
  send(detailEnvelope([minuteEntry(token, `${outputDir}\\artifact-synthetic-${token}\\transcript.txt`)]))
} else if (scenario === 'emptyfile') {
  const token = tokens[0]
  const file = writeTranscript(token, '')
  send(detailEnvelope([minuteEntry(token, file)]))
} else if (scenario === 'noartifact') {
  const token = tokens[0]
  send(detailEnvelope([minuteEntry(token, null)]))
} else {
  // ok / single：真的把正文写盘，stdout 只给路径（与真实 CLI 一致）。
  const text = scenario === 'single' ? `${LINE_1}\n${LINE_2}` : `${LINE_1}\n${LINE_2}\n${LINE_3}`
  const entries = tokens.map((token) => {
    process.stderr.write(`[minutes +detail] querying minute_token=${token} ...\n`)
    const file = writeTranscript(token, text)
    process.stderr.write(`[minutes +detail] writing transcript: ${file}\n`)
    return minuteEntry(token, file)
  })
  process.stderr.write(`[minutes +detail] done: ${entries.length} total, ${entries.length} succeeded, 0 failed\n`)
  send(detailEnvelope(entries))
}
