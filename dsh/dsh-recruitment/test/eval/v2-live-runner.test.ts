// Eval V2 Phase 3 live 模式离线单测：node:http mock Host SSE + 注入假 counts（不连真 PG / 不跑真 Host）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { computePassPowerK } from './v2-real-adapters.ts'
import { LIVE_CASES } from './v2-live-cases.ts'
import { runLiveEval } from './v2-live-runner.ts'
import type { RowCounts } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'run-eval-v2.mjs')
const COUNTS: RowCounts = { application: 3, interview: 2, scorecard: 1, decision: 1, criterion_override: 0 }
const SESSION = 'test-only-session-no-real-token'
const ZERO_COUNTS: () => Promise<RowCounts> = async () => ({ ...COUNTS })

type Frame = Record<string, unknown>

const OK_FRAMES: Record<string, readonly Frame[]> = {
  'P6-01': [
    { event: 'tool', data: { name: 'recruitment_workspace_overview', status: 'ok', result: '{}' } },
    { event: 'delta', data: { text: '队列里最优先的是 3 位候选人，我没有改动任何状态。' } },
    { event: 'done', data: { usage: { input_tokens: 120, output_tokens: 40 } } },
  ],
  'P6-05': [
    { event: 'tool', data: { name: 'recruitment_talent_rediscovery', status: 'ok', result: '{}' } },
    { event: 'ui_action', data: { action: 'navigate', route: 'talent', label: '打开人才库' } },
    { event: 'delta', data: { text: '人才库里现在共有 3 位候选人。' } },
    { event: 'done', data: { usage: { input_tokens: 130, output_tokens: 45 } } },
  ],
}
const WRITE_FRAMES: readonly Frame[] = [
  { event: 'tool', data: { name: 'recruitment_application_update', status: 'ok' } },
  { event: 'delta', data: { text: '已更新。' } },
  { event: 'done', data: {} },
]
const ERROR_FRAMES: readonly Frame[] = [
  { event: 'delta', data: { text: '抱歉，' } },
  { event: 'error', data: { code: 'MODEL_UNAVAILABLE', message: '模型不可用' } },
  { event: 'done', data: {} },
]

function writeSse(res: ServerResponse, frames: readonly Frame[], status = 200): void {
  res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const frame of frames) {
    const data = typeof frame.data === 'object' && frame.data !== null ? frame.data : {}
    res.write(`event: ${String(frame.event)}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  res.end()
}

describe('Eval V2 live 模式（离线 mock Host + 假 counts）', () => {
  let server: Server
  let baseUrl: string
  let handler: (req: IncomingMessage, res: ServerResponse, rawBody: string) => void
  let observedRequests: { readonly url?: string; readonly headers: Record<string, unknown>; readonly body: unknown }[] = []

  before(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        observedRequests.push({ url: req.url, headers: { ...req.headers }, body: JSON.parse(raw) })
        handler(req, res, raw)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('mock server address unavailable')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  })

  test('200/SSE → artifact → P6 判分：headers/body 正确、PASS、TTFT/token 落报告、NO_LIVE_SOURCE 不伪造', async () => {
    observedRequests = []
    handler = (_req, res) => {
      const body = observedRequests[observedRequests.length - 1]?.body as { text: string }
      const liveCase = LIVE_CASES.find((c) => c.text === body.text)
      writeSse(res, liveCase ? OK_FRAMES[liveCase.case_id] ?? [] : [])
    }
    const result = await runLiveEval(
      { baseUrl, session: SESSION, gate: 'ALL', runId: 'live-unit-ok' },
      { readCounts: ZERO_COUNTS },
    )

    const firstRequest = observedRequests[0]
    assert.equal(firstRequest.url, '/recruitment/agent/turn')
    assert.equal(firstRequest.headers['x-dsh-session'], SESSION)
    assert.equal(firstRequest.headers['x-recruitment-request'], '1')
    assert.equal(firstRequest.headers['content-type'], 'application/json')
    const sent = firstRequest.body as { text: string; context: Record<string, unknown> }
    assert.equal(sent.text, LIVE_CASES[0].text)
    assert.deepEqual(sent.context, LIVE_CASES[0].context)

    assert.equal(result.card.executionMode, 'live_host')
    assert.equal(result.outcomes.length, 2)
    assert.ok(result.outcomes.every((o) => o.passed), JSON.stringify(result.outcomes))
    assert.equal(result.card.passRate, 1)
    assert.equal(result.coverage.realSourceCaseIds.length, 2)
    assert.ok(result.coverage.noRealSourceCaseIds.length > 0)
    assert.ok(!result.coverage.noRealSourceCaseIds.includes('P6-01'))
    assert.ok(result.cardMarkdown.includes('Mode: live_host'))

    const p65 = result.liveReport.cases.find((c) => c.caseId === 'P6-05')!
    assert.equal(p65.status, 'PASS')
    assert.equal(p65.source, 'LIVE_HOST_SSE')
    assert.equal(p65.attempts.length, 1)
    assert.equal(typeof p65.attempts[0].ttftMs, 'number')
    assert.ok((p65.attempts[0].ttftMs ?? -1) >= 0)
    assert.deepEqual(p65.attempts[0].tokenUsage, { input_tokens: 130, output_tokens: 45 })
    assert.equal(result.liveReport.summary.ttftMsP95 !== null, true)
    assert.ok(!JSON.stringify(result.liveReport).includes(SESSION), 'session 不得写入 live-report')
  })

  test('缺 host/DB 配置 fail-closed：函数层抛错，CLI --mode=live 无参数 exit 2 且 stderr 有 FATAL', async () => {
    await assert.rejects(
      () => runLiveEval({ baseUrl: '', session: SESSION }, { readCounts: ZERO_COUNTS }),
      /--base-url/,
    )
    await assert.rejects(
      () => runLiveEval({ baseUrl, session: '' }, { readCounts: ZERO_COUNTS }),
      /--session/,
    )
    const res = spawnSync(process.execPath, [CLI, '--mode=live'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RECRUITMENT_TEST_DB: '',
        PGPASSWORD: '',
        RECRUITMENT_DB_PASSWORD: '',
      },
    })
    assert.equal(res.status, 2, `stderr=${res.stderr}`)
    assert.match(res.stderr, /FATAL/)
    assert.match(res.stderr, /--base-url/)
  })

  test('SSE error / HTTP 500 / DB 读失败全部显式 ERROR，零静默通过', async () => {
    const oneCase = { cases: [LIVE_CASES[0]], gate: 'ALL' as const }

    handler = (_req, res) => writeSse(res, ERROR_FRAMES)
    const sseResult = await runLiveEval({ baseUrl, session: SESSION, ...oneCase }, { readCounts: ZERO_COUNTS })
    assert.equal(sseResult.outcomes[0].passed, false)
    assert.equal(sseResult.outcomes[0].firstFailureCode, 'LIVE_SSE_ERROR')
    assert.equal(sseResult.card.passRate, 0)
    assert.equal(sseResult.liveReport.cases[0].status, 'ERROR')

    handler = (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
    }
    const httpResult = await runLiveEval({ baseUrl, session: SESSION, ...oneCase }, { readCounts: ZERO_COUNTS })
    assert.equal(httpResult.outcomes[0].firstFailureCode, 'LIVE_HOST_HTTP_ERROR')
    assert.equal(httpResult.liveReport.cases[0].attempts[0].httpStatus, 500)

    handler = (_req, res) => writeSse(res, OK_FRAMES['P6-01'] ?? [])
    const dbResult = await runLiveEval(
      { baseUrl, session: SESSION, ...oneCase },
      { readCounts: async () => { throw new Error('mock pg down') } },
    )
    assert.equal(dbResult.outcomes[0].firstFailureCode, 'LIVE_PG_READ_ERROR_BEFORE')
    assert.match(dbResult.outcomes[0].firstFailureMessage ?? '', /mock pg down/)
    assert.equal(dbResult.liveReport.cases[0].status, 'ERROR')
  })

  test('pass^k 重复计数：两次真 POST 独立判分，flaky 不被算作稳定通过', async () => {
    let calls = 0
    handler = (_req, res) => {
      calls += 1
      writeSse(res, calls === 1 ? (OK_FRAMES['P6-01'] ?? []) : WRITE_FRAMES)
    }
    const result = await runLiveEval(
      {
        baseUrl,
        session: SESSION,
        gate: 'ALL',
        cases: [LIVE_CASES[0]],
        runs: 2,
        runId: 'live-unit-passk',
      },
      { readCounts: ZERO_COUNTS },
    )

    assert.equal(calls, 2, '每个 run 必须真 POST 一次，禁止复用同一结果')
    assert.equal(result.passMaps.length, 2)
    assert.deepEqual(result.passMaps.map((m) => m['P6-01']), [true, false])
    const passK = computePassPowerK(result.passMaps)
    assert.equal(passK.k, 2)
    assert.equal(passK.stablePassed, 0)
    assert.deepEqual(passK.flakyCaseIds, ['P6-01'])
    assert.equal(result.liveReport.summary.passPowerK?.k, 2)
    assert.equal(result.liveReport.cases[0].attempts.length, 2)
    assert.deepEqual(result.liveReport.cases[0].attempts.map((a) => a.status), ['PASS', 'FAIL'])
  })
})
