// 假 Lark CLI：只为 `lark-cli-transport` 的测试提供一个**真实子进程**。
//
// 它不是 lark-cli，也不发任何网络请求：只按 `FAKE_LARK_CLI_SCENARIO` 回放固定
// JSON，用来验证传输层的进程管理、退出码、超时、分页与脱敏。
// 它产出的任何字节都只属于 FIXTURE 语料，**不得**被标成 LIVE。
//
// 调用形态（与 src/connectors/feishu/transport.ts 的 argv 约定一致）：
//   node fake-lark-cli.mjs minutes +detail --transcript \
//        --minute-token <token> --page-size <n> [--page-token <cursor>]
//
// 场景（environment FAKE_LARK_CLI_SCENARIO）：
//   ok（默认） 两页；single 一页；generating ok=false+2091003；
//   generating-stderr 退出 3 + stderr 里 2091003；nonzero 退出 3 + 未知码；
//   timeout 长时间不返回；stall 游标不前进；norevision 缺 revision；
//   empty 正文为空；micromatch 回显别的 minute_token；badenvelope 非 JSON；
//   leak 退出 5 且 stderr 里带「正文」（用来测 R7 脱敏）。
const argv = process.argv.slice(2)
const scenario = process.env.FAKE_LARK_CLI_SCENARIO ?? 'ok'
const tokenIndex = argv.indexOf('--minute-token')
const minuteToken = tokenIndex >= 0 ? (argv[tokenIndex + 1] ?? '') : ''
const cursorIndex = argv.indexOf('--page-token')
const cursor = cursorIndex >= 0 ? (argv[cursorIndex + 1] ?? '') : ''

/** 只写 stdout 的 JSON 信封（保持单行，避免测试断言受排版影响）。 */
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exit(0)
}

/** 写 stderr + 非零退出。 */
function fail(code, stderr) {
  process.stderr.write(`${stderr}\n`)
  process.exit(code)
}

// 一段**假**的面试正文（合成语料，不是任何真实候选人资料）。
const LINE_1 = '面试官：请先介绍一下你最近三年做过的项目，重点讲你负责的部分和遇到的困难。'
const LINE_2 = '候选人：我主要负责订单链路的稳定性，把超时率从百分之三降到千分之二，做法是加熔断和分级降级。'
const LINE_3 = '面试官：如果线上突然大量超时，你会先看哪些指标，怎么判断是依赖问题还是自身问题？'

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
} else if (scenario === 'stall') {
  send({ ok: true, data: { minute_token: minuteToken, revision: '7', has_more: true, page_token: 'p2', transcript: { sentences: [{ text: LINE_1 }] } } })
} else if (scenario === 'norevision') {
  send({ ok: true, data: { minute_token: minuteToken, has_more: false, transcript: { sentences: [{ text: LINE_1 }] } } })
} else if (scenario === 'empty') {
  send({ ok: true, data: { minute_token: minuteToken, revision: '7', has_more: false, transcript: { sentences: [] } } })
} else if (scenario === 'micromatch') {
  send({ ok: true, data: { minute_token: 'mt_someone_else', revision: '7', has_more: false, transcript: { sentences: [{ text: LINE_1 }] } } })
} else if (scenario === 'single') {
  send({ ok: true, data: { minute_token: minuteToken, revision: '11', has_more: false, transcript: { sentences: [{ text: LINE_1 }, { text: LINE_2 }] } } })
} else {
  // ok：两页，游标 p2 → 走真正的分页分支。
  if (cursor === 'p2') {
    send({ ok: true, data: { minute_token: minuteToken, revision: '7', has_more: false, transcript: { sentences: [{ text: LINE_3 }] } } })
  } else {
    send({
      ok: true,
      data: { minute_token: minuteToken, revision: '7', has_more: true, page_token: 'p2', transcript: { sentences: [{ text: LINE_1 }, { text: LINE_2 }] } },
    })
  }
}
