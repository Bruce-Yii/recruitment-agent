// Eval V2 Phase 3 — 可注入 L3 裁判 invoker 单测（全部用 fetchImpl 假实现，不联网）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  L3InvokerError,
  createL3Invoker,
  readL3InvokerConfig,
  type L3InvokerConfig,
} from './v2-l3-invoker.ts'

const DECISION = { verdict: 'pass', citedSourceQuote: '主导了支付网关改造', rationale: '事实一致' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(pieces: readonly string[]): Response {
  const encoder = new TextEncoder()
  const frames = [
    ...pieces.map((text) => `event: delta\ndata: ${JSON.stringify({ text })}\n\n`),
    `event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`,
  ]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function expectInvokerError(promise: Promise<unknown>, code: string): Promise<L3InvokerError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof L3InvokerError, `必须是 L3InvokerError，实际 ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`应当抛出 ${code}`)
}

describe('Eval V2 Phase 3：L3 裁判 invoker（openai_compatible）', () => {
  test('正常 JSON → 解析 verdict / quote / rationale，并校验请求体与 Bearer 头', async () => {
    let url = ''
    let init: RequestInit | undefined
    const fetchImpl: typeof fetch = async (input, requestInit) => {
      url = String(input)
      init = requestInit
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(DECISION) } }] })
    }
    const config: L3InvokerConfig = {
      backend: 'openai_compatible',
      baseUrl: 'https://api.example.com/v1/',
      model: 'judge-model',
      apiKey: 'secret-token',
    }
    const result = await createL3Invoker(config, { fetchImpl })('请裁判')
    assert.deepEqual(result, DECISION)
    assert.equal(url, 'https://api.example.com/v1/chat/completions')
    const headers = init?.headers as Record<string, string>
    assert.equal(headers.Authorization, 'Bearer secret-token')
    assert.equal(headers['content-type'], 'application/json')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(body.model, 'judge-model')
    assert.equal(body.temperature, 0)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    const messages = body.messages as { role: string; content: string }[]
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].content, '请裁判')
  })

  test('```json 代码块 + 前后废话 → 仍能括号配对提取判决', async () => {
    const content = [
      '好的，我按准则给出判决：',
      '```json',
      JSON.stringify(DECISION),
      '```',
      '以上仅供参考。',
    ].join('\n')
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ choices: [{ message: { content } }] })
    const invoker = createL3Invoker(
      { backend: 'openai_compatible', baseUrl: 'https://api.example.com/v1', model: 'judge-model' },
      { fetchImpl },
    )
    assert.deepEqual(await invoker('prompt'), DECISION)
  })

  test('非法 JSON / 缺 verdict → L3_JUDGE_BAD_JSON', async () => {
    const badContents = ['not json at all', '{"citedSourceQuote":"原文短句","rationale":"缺 verdict"}']
    for (const content of badContents) {
      const fetchImpl: typeof fetch = async () => jsonResponse({ choices: [{ message: { content } }] })
      const invoker = createL3Invoker(
        { backend: 'openai_compatible', baseUrl: 'https://api.example.com/v1', model: 'judge-model' },
        { fetchImpl },
      )
      await expectInvokerError(invoker('prompt'), 'L3_JUDGE_BAD_JSON')
    }
  })

  test('HTTP 500 → L3_JUDGE_HTTP_ERROR，且错误信息不含 apiKey', async () => {
    const apiKey = 'SUPER_SECRET_KEY_123'
    const fetchImpl: typeof fetch = async () =>
      new Response(`boom ${apiKey}`, { status: 500 })
    const invoker = createL3Invoker(
      {
        backend: 'openai_compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'judge-model',
        apiKey,
      },
      { fetchImpl },
    )
    const error = await expectInvokerError(invoker('prompt'), 'L3_JUDGE_HTTP_ERROR')
    assert.ok(!error.message.includes(apiKey), '错误信息不得包含 apiKey')
  })
})

describe('Eval V2 Phase 3：L3 裁判 invoker（host_agent）', () => {
  test('mock SSE delta/done → 跨帧拼接后解析；请求头与 body 符合协议', async () => {
    const json = JSON.stringify(DECISION)
    let url = ''
    let init: RequestInit | undefined
    const fetchImpl: typeof fetch = async (input, requestInit) => {
      url = String(input)
      init = requestInit
      return sseResponse([json.slice(0, 20), json.slice(20)])
    }
    const invoker = createL3Invoker(
      {
        backend: 'host_agent',
        baseUrl: 'http://127.0.0.1:49349',
        model: 'host-agent-judge',
        session: 'sess-abc',
      },
      { fetchImpl },
    )
    assert.deepEqual(await invoker('请裁判'), DECISION)
    assert.equal(url, 'http://127.0.0.1:49349/recruitment/agent/turn')
    const headers = init?.headers as Record<string, string>
    assert.equal(headers['x-dsh-session'], 'sess-abc')
    assert.equal(headers['x-recruitment-request'], '1')
    assert.equal(headers.Accept, 'text/event-stream')
    assert.deepEqual(JSON.parse(String(init?.body)), { text: '请裁判', context: { route: '#' } })
  })

  test('readL3InvokerConfig：host_agent 缺 session → configured:false 且有 reason', () => {
    const read = readL3InvokerConfig({
      RECRUITMENT_EVAL_L3_BACKEND: 'host_agent',
      RECRUITMENT_EVAL_L3_BASE_URL: 'http://127.0.0.1:49349',
      RECRUITMENT_EVAL_L3_MODEL: 'judge-model',
    })
    assert.equal(read.configured, false)
    assert.match(read.reason ?? '', /RECRUITMENT_EVAL_L3_SESSION/)
  })

  test('readL3InvokerConfig：完整 host_agent 配置 → configured:true', () => {
    const read = readL3InvokerConfig({
      RECRUITMENT_EVAL_L3_BACKEND: 'host_agent',
      RECRUITMENT_EVAL_L3_BASE_URL: 'http://127.0.0.1:49349',
      RECRUITMENT_EVAL_L3_MODEL: 'judge-model',
      RECRUITMENT_EVAL_L3_SESSION: 'sess-abc',
      RECRUITMENT_EVAL_L3_TIMEOUT_MS: '1234',
    })
    assert.equal(read.configured, true)
    assert.deepEqual(read.config, {
      backend: 'host_agent',
      baseUrl: 'http://127.0.0.1:49349',
      model: 'judge-model',
      session: 'sess-abc',
      timeoutMs: 1234,
    })
  })
})

describe('Eval V2 Phase 3：L3 裁判 invoker 配置 fail-closed', () => {
  test('未配置 env → configured:false + reason；不偷补旧变量', () => {
    const empty = readL3InvokerConfig({})
    assert.equal(empty.configured, false)
    assert.ok((empty.reason ?? '').length > 0)

    const legacy = readL3InvokerConfig({
      RECRUITMENT_EVAL_MODEL_PROVIDER: 'openai',
      RECRUITMENT_EVAL_MODEL: 'old-model',
    })
    assert.equal(legacy.configured, false)
    assert.match(legacy.reason ?? '', /RECRUITMENT_EVAL_L3_BACKEND/)
  })

  test('非法 backend / 非法 URL / 非法 timeout → 未配置', () => {
    const base = {
      RECRUITMENT_EVAL_L3_BACKEND: 'openai_compatible',
      RECRUITMENT_EVAL_L3_BASE_URL: 'https://api.example.com/v1',
      RECRUITMENT_EVAL_L3_MODEL: 'judge-model',
    }
    assert.equal(readL3InvokerConfig({ ...base, RECRUITMENT_EVAL_L3_BACKEND: 'other' }).configured, false)
    assert.equal(readL3InvokerConfig({ ...base, RECRUITMENT_EVAL_L3_BASE_URL: 'ftp://bad' }).configured, false)
    assert.equal(readL3InvokerConfig({ ...base, RECRUITMENT_EVAL_L3_TIMEOUT_MS: '0' }).configured, false)
  })
})
