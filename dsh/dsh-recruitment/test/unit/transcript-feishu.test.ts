// 线 2 · 飞书 Minutes Connector 的**诚实性**机检。
//
// 本文件只证明一件事：在没有真实飞书授权的情况下，系统的每一个出口都**说清楚
// 自己没连上、还差什么**，且**永远不会**输出 `provenance='LIVE'` /
// `connection='CONNECTED'`；唯一能产出 LIVE 的入口（完整回读）对 Fixture、
// webhook payload、缺回执、不完整内容一律抛 `LABEL_DISHONEST_LIVE`。
//
// 依据：`contracts/interview/transcript-rules.md` §2（TR-S1..S8）、§5（TR-F）、
// §8（完整性 Gate）、`tool-contracts.md §1.4`（三维标签正交）、`R4`。
//
// 这些不是「防御性单测」：任何一条变绿都意味着某处把外部资源说成了它还不是的东西。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FEISHU_LARK_CLI,
  FEISHU_MINUTES_CONTRACT_VERSION,
  FEISHU_MINUTES_ENDPOINTS,
  FEISHU_MINUTES_ENDPOINT_NOTES,
  FEISHU_MINUTES_EVENTS,
  FEISHU_MINUTES_EVENT_NOTES,
  FEISHU_MINUTES_SCOPES,
  FEISHU_PROVIDER_ERRORS,
  FEISHU_PROVIDER_ERROR_NOTES,
  buildBindingKey,
  isPageComplete,
  mapFeishuError,
} from '../../src/connectors/feishu/contract.ts'
import {
  buildArtifactLabelsFromReadback,
  buildConnectorLabels,
  isLiveEligible,
  liveEligibilityViolations,
  triggerModeForEvent,
} from '../../src/connectors/feishu/labels.ts'
import { createFeishuMinutesAdapter } from '../../src/connectors/feishu/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')
const CONNECTOR_DIR = join(PLUGIN_DIR, 'src', 'connectors', 'feishu')

/** 完全空的环境：什么都不给。 */
const EMPTY_ENV: Readonly<Record<string, string>> = {}
/** 只有应用凭据：飞书自建应用的最低配置。 */
const APP_ENV: Readonly<Record<string, string>> = {
  FEISHU_APP_ID: 'cli_app_test',
  FEISHU_APP_SECRET: 'app-secret-test',
}
/** 应用凭据 + 用户令牌：最接近「看起来能连上」的形态，但仍未验证。 */
const USER_ENV: Readonly<Record<string, string>> = {
  ...APP_ENV,
  FEISHU_USER_ACCESS_TOKEN: 'user-token-test',
}

/** 64 位小写 hex（合法 sha256 形态）。 */
const VALID_SHA = 'a'.repeat(64)

/** 一个「完整回读」样本；逐条覆盖 `liveEligibilityViolations()` 的六项证据。 */
function validReadback(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: 'FEISHU_MINUTES_API',
    read_receipt_ref: 'lark:minutes+detail:mt_1@1',
    fetched_at: '2026-11-13T10:00:00+08:00',
    content_sha256: VALID_SHA,
    is_complete: true,
    raw_text: '面试官：请先自我介绍一下。候选人：好的……',
    trigger: 'MANUAL',
    ...overrides,
  }
}

/** 一条「已验证」的事件样本。 */
function verifiedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'WEBHOOK_EVENT',
    verified: true,
    provider_event_id: 'evt_0001',
    ...overrides,
  }
}

type CodedError = Error & { code?: string }

/** `assert.throws` 的校验器：必须是带 `LABEL_DISHONEST_LIVE` 的 Error。 */
function isDishonestLive(error: unknown): boolean {
  assert.ok(error instanceof Error, '必须抛 Error')
  const coded = error as CodedError
  assert.equal(coded.code, 'LABEL_DISHONEST_LIVE')
  assert.match(coded.message, /^LABEL_DISHONEST_LIVE: /)
  return true
}

/** 取出必须抛出的错误（没抛就 fail）。 */
function caughtError(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  assert.fail('应该抛错，但没有抛')
}

/** 深扫一个出口对象里的所有 `labels` 块。 */
function collectLabels(
  value: unknown,
  path = 'root',
  out: Array<{ readonly path: string; readonly labels: Record<string, unknown> }> = [],
): Array<{ readonly path: string; readonly labels: Record<string, unknown> }> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLabels(item, `${path}[${index}]`, out))
    return out
  }
  if (typeof value !== 'object' || value === null) return out
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'labels' && typeof child === 'object' && child !== null) {
      out.push({ path: `${path}.${key}`, labels: child as Record<string, unknown> })
      continue
    }
    collectLabels(child, `${path}.${key}`, out)
  }
  return out
}

test('describe()：live_gate=BLOCKED，且明确列出没实现的东西', () => {
  const described = createFeishuMinutesAdapter({ env: EMPTY_ENV }).describe()
  assert.equal(described.connector, 'feishu-minutes')
  assert.equal(described.contract_version, FEISHU_MINUTES_CONTRACT_VERSION)
  assert.equal(described.live_gate, 'BLOCKED')
  assert.deepEqual(
    [...described.implemented].sort(),
    ['auth-check', 'contract', 'error-mapping', 'labels'],
  )
  for (const name of ['http-transport', 'lark-cli-transport', 'oauth-flow', 'event-subscription']) {
    assert.ok(described.not_implemented.includes(name), `not_implemented 必须说明 ${name}`)
  }
})

test('无 env：probe() → NOT_CONNECTED + FIXTURE/MANUAL + live_eligible=false', () => {
  const probed = createFeishuMinutesAdapter({ env: EMPTY_ENV }).probe()
  assert.equal(probed.connection_state, 'NOT_CONNECTED')
  assert.deepEqual(probed.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
  assert.equal(probed.provenance_basis, 'NO_LIVE_READ')
  assert.equal(probed.live_eligible, false)
  assert.equal(probed.blocked_reason, 'NO_APP_CREDENTIALS')
  assert.deepEqual([...probed.missing].sort(), ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'])
  assert.deepEqual(probed.credentials, {
    app_id_present: false,
    app_secret_present: false,
    user_token_present: false,
    tenant_token_present: false,
  })
})

test('只有应用凭据：probe() → AUTH_REQUIRED / USER_IDENTITY_REQUIRED，绝不 LIVE', () => {
  const probed = createFeishuMinutesAdapter({ env: APP_ENV }).probe()
  assert.equal(probed.connection_state, 'AUTH_REQUIRED')
  assert.equal(probed.blocked_reason, 'USER_IDENTITY_REQUIRED')
  assert.notEqual(probed.labels.provenance, 'LIVE')
  assert.notEqual(probed.labels.connection, 'CONNECTED')
  assert.equal(probed.live_eligible, false)
  assert.deepEqual(probed.missing, ['FEISHU_USER_ACCESS_TOKEN'])
  assert.equal(probed.credentials.app_id_present, true)
  assert.equal(probed.credentials.app_secret_present, true)
  assert.equal(probed.credentials.user_token_present, false)
})

test('有用户令牌：仍然不是 CONNECTED（TOKEN_PRESENT_UNVERIFIED），绝不 LIVE', () => {
  const probed = createFeishuMinutesAdapter({ env: USER_ENV }).probe()
  assert.notEqual(probed.connection_state, 'CONNECTED')
  assert.equal(probed.connection_state, 'AUTH_REQUIRED')
  assert.equal(probed.blocked_reason, 'TOKEN_PRESENT_UNVERIFIED')
  assert.notEqual(probed.labels.provenance, 'LIVE')
  assert.equal(probed.live_eligible, false)
  assert.equal(probed.credentials.user_token_present, true)
  assert.match(probed.note ?? '', /无法验证令牌/)
  assert.equal(probed.missing.length, 0)
})

test('只有租户令牌、没有用户令牌：仍是 USER_IDENTITY_REQUIRED（妙记是 user identity）', () => {
  const probed = createFeishuMinutesAdapter({
    env: { ...APP_ENV, FEISHU_TENANT_ACCESS_TOKEN: 'tenant-token-test' },
  }).probe()
  assert.equal(probed.blocked_reason, 'USER_IDENTITY_REQUIRED')
  assert.equal(probed.credentials.tenant_token_present, true)
  assert.equal(probed.credentials.user_token_present, false)
  assert.equal(probed.connection_state, 'AUTH_REQUIRED')
})

test('机检：所有出口的 labels 永不出现 provenance=LIVE / connection=CONNECTED', () => {
  const outputs: Array<readonly [string, unknown]> = []
  for (const [name, env] of [['empty', EMPTY_ENV], ['app', APP_ENV], ['user', USER_ENV]] as const) {
    const adapter = createFeishuMinutesAdapter({ env })
    outputs.push([`${name}.describe`, adapter.describe()])
    outputs.push([`${name}.probe`, adapter.probe()])
    outputs.push([`${name}.fetch(ok)`, adapter.fetchTranscript({ minute_token: 'mt_1', external_meeting_id: 'm_1' })])
    outputs.push([`${name}.fetch(no-token)`, adapter.fetchTranscript({ external_meeting_id: 'm_1' })])
    outputs.push([`${name}.mapProviderError('2091003')`, adapter.mapProviderError('2091003')])
    outputs.push([`${name}.mapProviderError('2091005')`, adapter.mapProviderError('2091005')])
    outputs.push([`${name}.mapProviderError('424242')`, adapter.mapProviderError('424242')])
    outputs.push([`${name}.subscriptionNotes`, adapter.subscriptionNotes()])
  }
  outputs.push(['labels.not-connected', buildConnectorLabels({ connection: 'NOT_CONNECTED' })])
  outputs.push(['labels.auth-required', buildConnectorLabels({ connection: 'AUTH_REQUIRED' })])
  outputs.push(['trigger.unverified', triggerModeForEvent({ kind: 'WEBHOOK_EVENT', verified: false, provider_event_id: 'evt_1' })])
  outputs.push(['trigger.webhook-payload', triggerModeForEvent({ kind: 'WEBHOOK_PAYLOAD', verified: true, provider_event_id: 'evt_1' })])

  let labelCount = 0
  for (const [name, value] of outputs) {
    for (const { path, labels } of collectLabels(value, name)) {
      labelCount += 1
      assert.notEqual(labels.provenance, 'LIVE', `${path} 输出了 provenance=LIVE`)
      assert.notEqual(labels.connection, 'CONNECTED', `${path} 输出了 connection=CONNECTED`)
      assert.equal(labels.trigger, 'MANUAL', `${path} 没有已验证事件却输出了非 MANUAL`)
      assert.ok(['FIXTURE', 'LIVE'].includes(String(labels.provenance)), `${path} 的 provenance 不在闭集里`)
      assert.ok(['EVENT', 'MANUAL'].includes(String(labels.trigger)), `${path} 的 trigger 不在闭集里`)
      assert.ok(
        ['CONNECTED', 'NOT_CONNECTED', 'AUTH_REQUIRED'].includes(String(labels.connection)),
        `${path} 的 connection 不在闭集里`,
      )
    }
    const json = JSON.stringify(value)
    assert.equal(json.includes('"provenance":"LIVE"'), false, `${name} 的 JSON 里出现 LIVE`)
    assert.equal(json.includes('"connection":"CONNECTED"'), false, `${name} 的 JSON 里出现 CONNECTED`)
  }
  assert.ok(labelCount >= 11, `应至少扫到 11 个 labels 块，实际 ${labelCount}`)

  // 错误映射没有 labels，也永远不建 artifact。
  for (const [name, value] of outputs) {
    if (!name.includes('mapProviderError')) continue
    const mapped = value as Record<string, unknown>
    assert.equal(mapped.creates_artifact, false, `${name} 居然允许建 artifact`)
    assert.equal('labels' in mapped, false, `${name} 不该带 labels（错误不是产物）`)
  }
})

test('buildConnectorLabels：无连接强制 FIXTURE/MANUAL；硬传 LIVE 抛 LABEL_DISHONEST_LIVE', () => {
  const notConnected = buildConnectorLabels({ connection: 'NOT_CONNECTED', provenance: 'FIXTURE', trigger: 'EVENT' })
  assert.deepEqual(notConnected.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
  assert.equal(notConnected.provenance_basis, 'NO_LIVE_READ')

  const authRequired = buildConnectorLabels({ connection: 'AUTH_REQUIRED', provenance: 'FIXTURE' })
  assert.deepEqual(authRequired.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED' })
  assert.equal(authRequired.provenance_basis, 'NO_LIVE_READ')

  for (const connection of ['NOT_CONNECTED', 'AUTH_REQUIRED', 'CONNECTED'] as const) {
    assert.throws(
      () => buildConnectorLabels({ connection, provenance: 'LIVE' }),
      isDishonestLive,
      `${connection} 也不能把连接状态当 LIVE 依据`,
    )
  }

  // 即使 connection=CONNECTED（本骨架不可达），provenance 也仍是 FIXTURE。
  const connected = buildConnectorLabels({ connection: 'CONNECTED', trigger: 'EVENT', provenance: 'FIXTURE' })
  assert.equal(connected.labels.provenance, 'FIXTURE')
})

test('buildArtifactLabelsFromReadback：Fixture / webhook payload / 缺证据一律抛', () => {
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ transport: 'FIXTURE' })), isDishonestLive)
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ transport: 'WEBHOOK_PAYLOAD' })), isDishonestLive)
  assert.match(
    caughtError(() => buildArtifactLabelsFromReadback(validReadback({ read_receipt_ref: undefined }))).message,
    /回执/,
  )
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ is_complete: false })), isDishonestLive)
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ is_complete: 'true' })), isDishonestLive)
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ content_sha256: 'deadbeef' })), isDishonestLive)
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ content_sha256: 'A'.repeat(64) })), isDishonestLive)
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ fetched_at: '2026-11-13 10:00' })), isDishonestLive)
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ raw_text: '   ' })), isDishonestLive)
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ trigger: 'AUTO' })), isDishonestLive)
  assert.throws(() => buildArtifactLabelsFromReadback(validReadback({ trigger: undefined })), isDishonestLive)

  assert.deepEqual(buildArtifactLabelsFromReadback(validReadback()), {
    provenance: 'LIVE',
    trigger: 'MANUAL',
    connection: 'CONNECTED',
  })
  assert.deepEqual(buildArtifactLabelsFromReadback(validReadback({ trigger: 'EVENT' })), {
    provenance: 'LIVE',
    trigger: 'EVENT',
    connection: 'CONNECTED',
  })
})

test('isLiveEligible：只有完整回读对象才 true，且与违规列表一致', () => {
  assert.equal(isLiveEligible(validReadback()), true)
  assert.deepEqual(liveEligibilityViolations(validReadback()), [])

  for (const overrides of [
    { transport: 'FIXTURE' },
    { transport: 'WEBHOOK_PAYLOAD' },
    { read_receipt_ref: '' },
    { fetched_at: '' },
    { content_sha256: '' },
    { is_complete: false },
    { raw_text: '' },
    { trigger: 'AUTO' },
  ]) {
    const readback = validReadback(overrides)
    assert.equal(isLiveEligible(readback), false, `不该 eligible：${JSON.stringify(overrides)}`)
    assert.ok(liveEligibilityViolations(readback).length > 0)
  }
  assert.equal(isLiveEligible(null), false)
  assert.equal(isLiveEligible('回读'), false)
})

test('triggerModeForEvent：只有已验证 + 有 provider_event_id 才是 EVENT', () => {
  assert.equal(triggerModeForEvent(verifiedEvent()), 'EVENT')
  assert.equal(triggerModeForEvent({ kind: 'WEBHOOK_EVENT', verified: true, provider_event_id: 'evt_1' }), 'EVENT')
  assert.equal(triggerModeForEvent({ kind: 'WEBHOOK_EVENT', verified: true, provider_event_id: '' }), 'MANUAL')
  assert.equal(triggerModeForEvent({ kind: 'WEBHOOK_EVENT', verified: true, provider_event_id: '   ' }), 'MANUAL')
  assert.equal(triggerModeForEvent({ kind: 'WEBHOOK_EVENT', verified: true }), 'MANUAL')
  assert.equal(triggerModeForEvent({ kind: 'WEBHOOK_EVENT', verified: false, provider_event_id: 'evt_1' }), 'MANUAL')
  assert.equal(triggerModeForEvent({ kind: 'WEBHOOK_PAYLOAD', verified: true, provider_event_id: 'evt_1' }), 'MANUAL')
  assert.equal(triggerModeForEvent({ kind: 'FIXTURE', verified: true, provider_event_id: 'evt_1' }), 'MANUAL')
  assert.equal(
    triggerModeForEvent({ kind: 'WEBHOOK_EVENT', verified: true, provider_event_id: 'evt_1', request_body_is_transcript: true }),
    'MANUAL',
    '自称请求体就是逐字稿的载荷不得计入 EVENT',
  )
  assert.equal(triggerModeForEvent(null), 'MANUAL')
  assert.equal(triggerModeForEvent(undefined), 'MANUAL')
})

test('mapFeishuError：2091003/2091005 已核对，未知码不猜，任何错误都不建 artifact', () => {
  const generating = mapFeishuError('2091003')
  assert.equal(generating.provider_code, '2091003')
  assert.equal(generating.kind, 'GENERATING')
  assert.equal(generating.task_state, 'WAITING_EXTERNAL')
  assert.equal(generating.creates_artifact, false)
  assert.equal('error_code' in generating, false)
  assert.equal('provenance' in generating, false)

  const noPermission = mapFeishuError(2091005)
  assert.equal(noPermission.provider_code, '2091005')
  assert.equal(noPermission.kind, 'NO_PERMISSION')
  assert.equal(noPermission.task_state, 'WAITING_HUMAN')
  assert.equal(noPermission.error_code, 'AUTH_REQUIRED')
  assert.equal(noPermission.creates_artifact, false)

  const fromResponse = mapFeishuError({ code: 2091005, msg: 'no permission for this minute' })
  assert.equal(fromResponse.error_code, 'AUTH_REQUIRED')
  assert.equal(fromResponse.creates_artifact, false)
  assert.equal(
    JSON.stringify(fromResponse).includes('no permission for this minute'),
    false,
    '平台 msg 不回显（可能带租户内容）',
  )

  const unknown = mapFeishuError('424242')
  assert.equal(unknown.provider_code, '424242')
  assert.equal(unknown.kind, 'UNKNOWN')
  assert.equal(unknown.creates_artifact, false)

  const unparsable = mapFeishuError({ msg: 'boom' })
  assert.equal(unparsable.provider_code, '')
  assert.equal(unparsable.kind, 'UNKNOWN')
  assert.equal(unparsable.creates_artifact, false)

  // 没有别名表：任何未核对的码（包括看起来同族的）都只能 UNKNOWN，不猜。
  const lookalike = mapFeishuError('9999999')
  assert.equal(lookalike.provider_code, '9999999')
  assert.equal(lookalike.kind, 'UNKNOWN')
  assert.equal(lookalike.task_state, 'WAITING_HUMAN')
  assert.equal(lookalike.creates_artifact, false)
  for (const code of ['2081003', '2091004', '2091006']) {
    assert.equal(mapFeishuError(code).kind, 'UNKNOWN', `${code} 没有依据，不得被映射`)
  }
})

test('契约常量：端点 / CLI / 事件 / scope / 错误码都在，且带依据注记', () => {
  assert.equal(FEISHU_MINUTES_CONTRACT_VERSION, '1.0.0')

  assert.equal(FEISHU_MINUTES_ENDPOINTS['minutes.detail'], '/open-apis/minutes/v1/minutes/{minute_token}')
  assert.equal(FEISHU_MINUTES_ENDPOINTS['minutes.transcript'], '/open-apis/minutes/v1/minutes/{minute_token}/transcript')
  for (const [key, endpoint] of Object.entries(FEISHU_MINUTES_ENDPOINTS)) {
    assert.ok(endpoint.startsWith('/open-apis/'), `${key} 必须是绝对路径形态`)
    const note = FEISHU_MINUTES_ENDPOINT_NOTES[key as keyof typeof FEISHU_MINUTES_ENDPOINTS]
    assert.ok(typeof note === 'string' && note.includes('未核实'), `${key} 必须注明「未核实/骨架占位」`)
  }

  assert.equal(FEISHU_LARK_CLI.minutesDetailTranscript, 'minutes +detail --transcript')
  assert.equal(FEISHU_LARK_CLI.vcRecording, 'vc +recording')

  assert.equal(FEISHU_MINUTES_EVENTS.minutes_generated, 'minutes.minute.generated_v1')
  assert.equal(
    FEISHU_MINUTES_EVENTS.vc_recording_transcript_generated,
    'vc.recording.recording_transcript_generated_v1',
  )
  const minutesNote = FEISHU_MINUTES_EVENT_NOTES['minutes.minute.generated_v1']
  assert.equal(minutesNote.identity, 'USER')
  assert.match(minutesNote.note, /user identity/)
  const vcNote = FEISHU_MINUTES_EVENT_NOTES['vc.recording.recording_transcript_generated_v1']
  assert.equal(vcNote.usable_as_batch_archive_basis, false)
  assert.match(vcNote.note, /片段/)

  assert.ok(Object.values(FEISHU_MINUTES_SCOPES).includes('minutes:minutes:readonly'))
  assert.ok(Object.values(FEISHU_MINUTES_SCOPES).includes('minutes:minutes.transcript:readonly'))
  assert.ok(Object.values(FEISHU_MINUTES_SCOPES).includes('offline_access'))

  assert.deepEqual(FEISHU_PROVIDER_ERRORS['2091003'], {
    kind: 'GENERATING',
    task_state: 'WAITING_EXTERNAL',
    creates_artifact: false,
  })
  assert.deepEqual(FEISHU_PROVIDER_ERRORS['2091005'], {
    kind: 'NO_PERMISSION',
    task_state: 'WAITING_HUMAN',
    error_code: 'AUTH_REQUIRED',
    creates_artifact: false,
  })
  for (const code of ['2091003', '2091005']) {
    assert.ok((FEISHU_PROVIDER_ERROR_NOTES[code] ?? '').length > 0, `${code} 缺注记`)
  }
})

test('buildBindingKey：只靠平台 ID，缺 minute_token / Meeting ID 直接失败', () => {
  const event = buildBindingKey({
    kind: 'WEBHOOK_EVENT',
    verified: true,
    event_id: 'evt_1',
    minute_token: 'mt_1',
    source_entity_id: 'm_1',
  })
  assert.equal(event.ok, true)
  if (event.ok) {
    assert.deepEqual(event.key, {
      provider: 'FEISHU',
      minute_token: 'mt_1',
      external_meeting_id: 'm_1',
      trigger: 'EVENT',
      provider_event_id: 'evt_1',
    })
  }

  const manual = buildBindingKey({ kind: 'WEBHOOK_PAYLOAD', event_id: 'evt_2', minute_token: 'mt_1', source_entity_id: 'm_1' })
  assert.equal(manual.ok, true)
  if (manual.ok) {
    assert.equal(manual.key.trigger, 'MANUAL')
    assert.equal(manual.key.provider_event_id, 'evt_2')
  }

  const noMinuteToken = buildBindingKey({ source_entity_id: 'm_1' })
  assert.equal(noMinuteToken.ok, false)
  if (!noMinuteToken.ok) assert.equal(noMinuteToken.reason_code, 'MINUTE_TOKEN_REQUIRED')

  const noMeeting = buildBindingKey({ minute_token: 'mt_1' })
  assert.equal(noMeeting.ok, false)
  if (!noMeeting.ok) assert.equal(noMeeting.reason_code, 'SOURCE_ENTITY_ID_REQUIRED')
})

test('isPageComplete：只认 has_more=false 且没有下一页游标（TR-C2）', () => {
  assert.equal(isPageComplete({ has_more: false }), true)
  assert.equal(isPageComplete({ has_more: false, page_token: '' }), true)
  assert.equal(isPageComplete({ has_more: false, page_token: 'next' }), false)
  assert.equal(isPageComplete({ has_more: true }), false)
  assert.equal(isPageComplete({}), false)
  assert.equal(isPageComplete(null), false)
})

test('fetchTranscript：永不取数、永不建 artifact、不回声 minute_token', () => {
  const withToken = createFeishuMinutesAdapter({ env: USER_ENV })
  const blocked = withToken.fetchTranscript({ minute_token: 'mt_1', external_meeting_id: 'm_1' })
  assert.equal(blocked.kind, 'BLOCKED')
  assert.equal(blocked.creates_artifact, false)
  assert.equal(blocked.error_code, 'AUTH_REQUIRED')
  assert.notEqual(blocked.labels.connection, 'CONNECTED')
  assert.equal(blocked.labels.provenance, 'FIXTURE')
  assert.equal(blocked.labels.trigger, 'MANUAL')
  assert.deepEqual(blocked.requested, { minute_token_present: true, external_meeting_id_present: true })
  assert.equal('raw_text' in blocked, false, '不得返回正文')
  assert.equal('artifact' in blocked, false, '不得返回伪造 artifact')
  assert.equal(JSON.stringify(blocked).includes('mt_1'), false, '不得回声 minute_token')

  const invalid = withToken.fetchTranscript({ external_meeting_id: 'm_1' })
  assert.equal(invalid.kind, 'ERROR')
  assert.equal(invalid.error_code, 'INVALID_ARGS')
  assert.equal(invalid.reason_code, 'MINUTE_TOKEN_REQUIRED')
  assert.equal(invalid.creates_artifact, false)
  assert.deepEqual(invalid.requested, { minute_token_present: false, external_meeting_id_present: true })

  const noCreds = createFeishuMinutesAdapter({ env: EMPTY_ENV }).fetchTranscript({ minute_token: 'mt_1' })
  assert.equal(noCreds.kind, 'BLOCKED')
  assert.equal(noCreds.error_code, 'NOT_CONNECTED')
  assert.equal(noCreds.connection_state, 'NOT_CONNECTED')
  assert.equal(JSON.stringify(noCreds).includes('mt_1'), false)
})

test('subscriptionNotes：minutes 是 user identity，片段事件不能单独作批量依据', () => {
  const notes = createFeishuMinutesAdapter({ env: EMPTY_ENV }).subscriptionNotes()
  assert.equal(notes.webhook_payload_is_transcript, false)
  const minutesNote = notes.events.find((entry) => entry.event === 'minutes.minute.generated_v1')
  assert.ok(minutesNote !== undefined)
  assert.equal(minutesNote.identity, 'USER')
  assert.match(minutesNote.note, /user identity/)
  const vcNote = notes.events.find((entry) => entry.event === 'vc.recording.recording_transcript_generated_v1')
  assert.ok(vcNote !== undefined)
  assert.equal(vcNote.usable_as_batch_archive_basis, false)
  assert.ok(notes.rules.length > 0)
})

test('probe() 输出里不含任何 env 值（只有存在性布尔）', () => {
  const secret = 'super-secret-value'
  const adapter = createFeishuMinutesAdapter({
    env: {
      FEISHU_APP_ID: secret,
      FEISHU_APP_SECRET: secret,
      FEISHU_USER_ACCESS_TOKEN: secret,
      FEISHU_TENANT_ACCESS_TOKEN: secret,
    },
  })
  const probed = adapter.probe()
  assert.equal(JSON.stringify(probed).includes(secret), false, 'probe() 泄露了 env 值')
  assert.equal(probed.credentials.app_id_present, true)
  assert.equal(probed.credentials.app_secret_present, true)
  assert.equal(probed.credentials.user_token_present, true)
  assert.equal(probed.credentials.tenant_token_present, true)

  // 直接给了 app_id 时也不回声它。
  const direct = createFeishuMinutesAdapter({ app_id: secret, env: { FEISHU_APP_SECRET: secret } }).probe()
  assert.equal(JSON.stringify(direct).includes(secret), false, 'probe() 泄露了 config.app_id')
})

/** 扫描口径：源文件里不许出现真实传输手段（骨架就该是死的）。 */
const FORBIDDEN_SOURCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['fetch(', /fetch\s*\(/],
  ['node:http', /node:http/],
  ['node:https', /node:https/],
  ['node:net', /node:net/],
  ['undici', /undici/i],
  ['child_process', /child_process/],
  ['spawn', /\bspawn\b/i],
  ['execSync', /\bexecSync\b/],
]

/** 列出 `src/connectors/feishu/` 下所有 .ts 文件。 */
async function listConnectorSources(): Promise<string[]> {
  const entries = await readdir(CONNECTOR_DIR, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

test('静态扫描：src/connectors/feishu/** 没有 HTTP / 套接字 / 子进程调用', async () => {
  const files = await listConnectorSources()
  assert.ok(files.length >= 4, `应至少扫到 4 个 .ts 文件，实际 ${files.length}`)
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const [label, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
      assert.equal(pattern.test(text), false, `${file} 命中禁用形态 ${label}`)
    }
    assert.equal(/\brequire\s*\(/.test(text), false, `${file} 不该用 require()`)
  }
})
