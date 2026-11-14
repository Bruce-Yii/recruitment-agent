// DSH Worker 协议的纯单元测试（不连库、不起进程）：
//   * NDJSON 解析：session / final / 非 JSON 诊断行；
//   * 模型回包 JSON 提取（允许 fenced code、前后思考文本）；
//   * 任务书包含 Task/Attempt 身份与"只回一个 JSON"的契约；
//   * runtime 配置解析：默认关闭、缺配置逐条 issues、lease < timeout 被拒；
//   * 未配置 dsh bin 时 launcher 明确抛 WORKER_RUNTIME_NOT_CONFIGURED（不是假执行）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveRuntimeConfig } from '../../src/runtime/config.ts'
import { RuntimeError } from '../../src/runtime/errors.ts'
import {
  buildWorkerPrompt,
  DshHeadlessWorkerLauncher,
  extractJsonObject,
  parseWorkerEvents,
} from '../../src/runtime/worker.ts'

describe('worker NDJSON protocol', () => {
  test('parses session id and final event while ignoring diagnostic lines', () => {
    const text = [
      '[llm adapter] model listing loaded 2 model(s)',
      '{"type":"session","sessionId":"session-abc","cwd":"D:\\\\work"}',
      '{"type":"status","phase":"turn_start","turn":1}',
      '{"type":"thinking","text":"..."}',
      '{"type":"final","sessionId":"session-abc","reason":{"kind":"completed"},"text":"{\\"state\\":\\"succeeded\\",\\"summary\\":\\"ok\\"}"}',
      '',
    ].join('\n')
    const parsed = parseWorkerEvents(text)
    assert.equal(parsed.sessionId, 'session-abc')
    assert.ok(parsed.final !== null)
    assert.equal((parsed.final.reason as Record<string, unknown>).kind, 'completed')
  })

  test('extracts a JSON object from fenced or surrounded text', () => {
    assert.deepEqual(extractJsonObject('```json\n{"state":"succeeded","summary":"ok"}\n```'), {
      state: 'succeeded',
      summary: 'ok',
    })
    assert.deepEqual(extractJsonObject('prefix {"state":"blocked","summary":"need human"} suffix'), {
      state: 'blocked',
      summary: 'need human',
    })
    assert.equal(extractJsonObject('no json here'), null)
    assert.equal(extractJsonObject('{"broken":'), null)
  })
})

describe('worker task contract', () => {
  test('task prompt carries stable task/attempt identity and the single-JSON result contract', () => {
    const prompt = buildWorkerPrompt({
      taskId: '11111111-1111-4111-8111-000000000001',
      attemptId: '22222222-2222-4222-8222-000000000002',
      attemptNo: 3,
      taskType: 'RESUME_PARSE',
      title: '解析简历',
      description: 'parse this resume',
      businessRefs: [{ type: 'APPLICATION', id: '33333333-3333-4333-8333-000000000003' }],
      prompt: '',
      resumeSessionId: null,
      workspaceDir: 'D:/work/runtime/task',
    })
    assert.match(prompt, /Business Task/)
    assert.match(prompt, /"task_id":"11111111-1111-4111-8111-000000000001"/)
    assert.match(prompt, /"attempt_no":3/)
    assert.match(prompt, /EXACTLY ONE JSON object/)
    assert.match(prompt, /untrusted data/)
  })
})

describe('runtime config resolution', () => {
  const valid = {
    enabled: true,
    worker_profile: 'rec-worker-probe',
    dsh_bin: 'D:/runtime/dsh/lib/bin.js',
    runtime_version: '0.2.2-rc.3',
    model_route: 'opencode-go-openai-key2/longcat-2.5-free',
  } as const

  test('disabled by default', () => {
    const { resolved, issues } = resolveRuntimeConfig({}, {})
    assert.equal(resolved, null)
    assert.match(issues[0] ?? '', /enabled is false/)
  })

  test('missing worker identity fields are listed, not defaulted', () => {
    const { resolved, issues } = resolveRuntimeConfig({ enabled: true }, {})
    assert.equal(resolved, null)
    assert.ok(issues.some((issue) => issue.includes('worker_profile')))
    assert.ok(issues.some((issue) => issue.includes('runtime_version')))
    assert.ok(issues.some((issue) => issue.includes('model_route')))
  })

  test('lease must exceed worker timeout', () => {
    const { resolved, issues } = resolveRuntimeConfig({ ...valid, timeout_ms: 120000, lease_ms: 60000 }, {})
    assert.equal(resolved, null)
    assert.ok(issues.some((issue) => issue.includes('lease_ms')))
  })

  test('valid config resolves the DSH worker profile', () => {
    const { resolved, issues } = resolveRuntimeConfig(valid, {})
    assert.deepEqual(issues, [])
    assert.ok(resolved !== null)
    assert.equal(resolved.worker.profile, 'rec-worker-probe')
    assert.equal(resolved.worker.dshBin, 'D:/runtime/dsh/lib/bin.js')
    assert.equal(resolved.leaseMs > (resolved.worker.timeoutMs ?? 0), true)
  })

  test('launcher refuses to run without a dsh bin instead of pretending', () => {
    const launcher = new DshHeadlessWorkerLauncher({
      profile: 'p',
      runtimeVersion: 'v',
      modelRoute: 'm',
    })
    const original = process.env.DSH_INSTALL_DIR
    try {
      delete process.env.DSH_INSTALL_DIR
      assert.throws(
        () => launcher.resolveCommand(),
        (error: unknown) => error instanceof RuntimeError && error.code === 'WORKER_RUNTIME_NOT_CONFIGURED',
      )
    } finally {
      if (original !== undefined) process.env.DSH_INSTALL_DIR = original
    }
  })
})
