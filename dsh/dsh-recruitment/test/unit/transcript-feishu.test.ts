// 线 2 · 飞书 Minutes Connector 的**诚实性**机检。
//
// 本文件只证明一件事：`provenance='LIVE'` **只能由回读证据算出**，不是常量、
// 不是自报。`evaluateLiveGate()` 是唯一判定入口：证据齐全 → LIVE；缺任何一项
// （平台通道 / 回执 @sha256 / content_sha256 与 raw_text 重算一致 / 重读哈希 /
// 带偏移 fetched_at / 完整分页 / 非空正文 / MANUAL|EVENT）→ BLOCKED，并逐条
// 点名缺什么。回读不一致是**失败**，不是警告。
//
// 依据：`contracts/interview/transcript-rules.md` §2（TR-S1..S8）、§5（TR-F）、
// §8（完整性 Gate）、`tool-contracts.md §1.4`（三维标签正交）、`R4`、`D-1`。
//
// 这些不是「防御性单测」：任何一条变绿都意味着某处把外部资源说成了它还不是的东西。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FEISHU_LARK_CLI,
  FEISHU_LIVE_GATE_POLICY,
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
  LIVE_EVIDENCE_ITEMS,
  LIVE_READBACK_PROVENANCE_BASIS,
  buildArtifactLabelsFromReadback,
  buildConnectorLabels,
  evaluateLiveGate,
  isLiveEligible,
  liveEligibilityViolations,
  liveGateEvidence,
  parseReadReceipt,
  readbackConsistencyViolations,
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

/** 合成正文（不是任何真实候选人/会议内容，R7）。 */
const RAW_TEXT = '面试官：请先自我介绍一下。候选人：好的，我最近三年主要做订单链路。'
/** 与 `RAW_TEXT` 逐字节一致的 sha256（回读对象声明的 content_sha256 必须是它）。 */
const VALID_SHA = createHash('sha256').update(RAW_TEXT, 'utf8').digest('hex')

/** 一个「四样 LIVE 证据齐全」样本；逐条覆盖 `liveEligibilityViolations()` 的证据项。 */
function validReadback(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: 'FEISHU_MINUTES_API',
    read_receipt_ref: `lark:minutes+detail:mt_1@sha256:${VALID_SHA}`,
    fetched_at: '2026-11-13T10:00:00+08:00',
    content_sha256: VALID_SHA,
    // 第二次独立完整回读的哈希：与 content_sha256 一致（重读校验通过）。
    reread_sha256: VALID_SHA,
    is_complete: true,
    raw_text: RAW_TEXT,
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

test('describe()：live_gate 是口径名 EVIDENCE_DRIVEN（不是开关），且列出没实现的东西与证据项', () => {
  const described = createFeishuMinutesAdapter({ env: EMPTY_ENV }).describe()
  assert.equal(described.connector, 'feishu-minutes')
  assert.equal(described.contract_version, FEISHU_MINUTES_CONTRACT_VERSION)
  // Gate 不再是「开/关」常量：describe 只报口径 + 证据清单，状态按每次读取算。
  assert.equal(FEISHU_LIVE_GATE_POLICY, 'EVIDENCE_DRIVEN')
  assert.equal(described.live_gate, 'EVIDENCE_DRIVEN')
  assert.deepEqual([...described.live_gate_evidence], [...LIVE_EVIDENCE_ITEMS])
  assert.ok(described.live_gate_evidence.includes('read_receipt_ref'))
  assert.ok(described.live_gate_evidence.includes('readback_hash_consistency'))
  assert.deepEqual(
    [...described.implemented].sort(),
    ['auth-check', 'contract', 'error-mapping', 'labels', 'lark-cli-transport'],
  )
  // 未实现的仍然必须逐项写明；`lark-cli-transport` 已实现，因此不再出现在这里。
  assert.deepEqual([...described.not_implemented], ['http-transport', 'oauth-flow', 'event-subscription'])
  assert.equal(described.not_implemented.includes('lark-cli-transport'), false)
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

test('机检：所有出口的 labels 永不出现 provenance=LIVE / connection=CONNECTED', async () => {
  const outputs: Array<readonly [string, unknown]> = []
  for (const [name, env] of [['empty', EMPTY_ENV], ['app', APP_ENV], ['user', USER_ENV]] as const) {
    const adapter = createFeishuMinutesAdapter({ env })
    outputs.push([`${name}.describe`, adapter.describe()])
    outputs.push([`${name}.probe`, adapter.probe()])
    outputs.push([`${name}.fetch(ok)`, await adapter.fetchTranscript({ minute_token: 'mt_1', external_meeting_id: 'm_1' })])
    outputs.push([`${name}.fetch(no-token)`, await adapter.fetchTranscript({ external_meeting_id: 'm_1' })])
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

test('evaluateLiveGate：四样证据齐全 → LIVE / MANUAL，且给出 LIVE_READBACK_VERIFIED', () => {
  const decision = evaluateLiveGate(validReadback())
  assert.equal(decision.gate, 'LIVE')
  assert.deepEqual(decision.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
  assert.equal(decision.provenance_basis, LIVE_READBACK_PROVENANCE_BASIS)
  assert.deepEqual(decision.violations, [])
  // 证据快照：声明的哈希与重算哈希逐字相等（回读重新读取一致）。
  assert.equal(decision.evidence.content_sha256, VALID_SHA)
  assert.equal(decision.evidence.content_sha256_recomputed, VALID_SHA)
  assert.equal(decision.evidence.reread_sha256, VALID_SHA)
  assert.equal(decision.evidence.minute_token, 'mt_1')
  assert.equal(decision.evidence.raw_text_chars, RAW_TEXT.length)

  // buildArtifactLabelsFromReadback 只是同一判定的抛错版本。
  assert.deepEqual(buildArtifactLabelsFromReadback(validReadback()), decision.labels)
  assert.deepEqual(buildArtifactLabelsFromReadback(validReadback({ trigger: 'EVENT' })), {
    provenance: 'LIVE',
    trigger: 'EVENT',
    connection: 'CONNECTED',
  })
})

test('evaluateLiveGate 负例：缺任何一样证据都不是 LIVE，并说清缺什么（不是「全局 Gate 没开」）', () => {
  /** 断言 gate=BLOCKED 且违规里能匹配到指定证据关键词。 */
  function expectBlocked(overrides: Record<string, unknown>, pattern: RegExp, label: string): void {
    const decision = evaluateLiveGate(validReadback(overrides))
    assert.equal(decision.gate, 'BLOCKED', `${label} 不该是 LIVE`)
    assert.equal(decision.labels.provenance, 'FIXTURE', `${label} 的 provenance 不该是 LIVE`)
    assert.notEqual(decision.labels.connection, 'CONNECTED', `${label} 的 connection 不该是 CONNECTED`)
    assert.equal(decision.provenance_basis, 'NO_LIVE_READ')
    assert.ok(decision.violations.length > 0, `${label} 必须给出违规原因`)
    assert.ok(
      decision.violations.some((violation) => pattern.test(violation)),
      `${label} 的违规里应点名 ${pattern}，实际：${decision.violations.join('；')}`,
    )
    // 抛错版本必须同样拒绝，且错误 message 里带同样原因。
    assert.throws(() => buildArtifactLabelsFromReadback(validReadback(overrides)), isDishonestLive)
    assert.match(
      caughtError(() => buildArtifactLabelsFromReadback(validReadback(overrides))).message,
      pattern,
    )
  }

  expectBlocked({ transport: 'FIXTURE' }, /transport/, 'fake transport（FIXTURE）')
  expectBlocked({ transport: 'WEBHOOK_PAYLOAD' }, /transport/, 'webhook payload 冒充逐字稿')
  expectBlocked({ read_receipt_ref: undefined }, /回执/, '缺 read_receipt_ref')
  expectBlocked({ read_receipt_ref: '' }, /回执/, '空 read_receipt_ref')
  expectBlocked(
    { read_receipt_ref: 'lark:minutes+detail:mt_1@1' },
    /回执形状不对/,
    '回执只有 revision、没绑内容哈希',
  )
  expectBlocked(
    { read_receipt_ref: `lark:minutes+detail:mt_1@sha256:${'0'.repeat(12)}` },
    /回执哈希与内容不一致/,
    '回执哈希与 content_sha256 不一致',
  )
  // sha 格式不对：短 hex / 大写 / 非 hex。
  expectBlocked({ content_sha256: 'deadbeef' }, /content_sha256/, 'sha 太短')
  expectBlocked({ content_sha256: 'A'.repeat(64) }, /content_sha256/, 'sha 大写')
  expectBlocked({ content_sha256: 'z'.repeat(64) }, /content_sha256/, 'sha 非 hex')
  // 回读哈希不一致：声明的 sha 与 raw_text 重算结果不等 = 失败，不是警告。
  expectBlocked(
    { content_sha256: 'b'.repeat(64), read_receipt_ref: `lark:minutes+detail:mt_1@sha256:${'b'.repeat(64)}` },
    /回读哈希不一致/,
    'content_sha256 与 raw_text 不一致',
  )
  expectBlocked({ reread_sha256: 'c'.repeat(64) }, /重读哈希不一致/, 'reread_sha256 与 content_sha256 不一致')
  expectBlocked({ reread_sha256: 'short' }, /reread_sha256/, 'reread_sha256 格式不对')
  // fetched_at 无时区 / 非法 / 日历越界。
  expectBlocked({ fetched_at: '2026-11-13 10:00' }, /fetched_at/, 'fetched_at 无时区')
  expectBlocked({ fetched_at: '2026-11-13T10:00:00' }, /fetched_at/, 'fetched_at 缺偏移')
  expectBlocked({ fetched_at: '2026-02-30T10:00:00+08:00' }, /fetched_at/, 'fetched_at 非法日期')
  expectBlocked({ is_complete: false }, /is_complete/, '分页没取完')
  expectBlocked({ is_complete: 'true' }, /is_complete/, 'is_complete 不是布尔')
  expectBlocked({ raw_text: '   ' }, /raw_text/, '正文为空')
  expectBlocked({ trigger: 'AUTO' }, /trigger/, 'trigger 不是 EVENT/MANUAL')
  expectBlocked({ trigger: undefined }, /trigger/, '缺 trigger')

  // 缺证据时出口**逐条**列出缺什么，不是一句「Gate 没开」。
  const many = evaluateLiveGate(validReadback({ transport: 'FIXTURE', fetched_at: 'bad' }))
  assert.ok(many.violations.length >= 2)
  assert.ok(many.violations.some((violation) => violation.includes('transport')))
  assert.ok(many.violations.some((violation) => violation.includes('fetched_at')))

  assert.equal(evaluateLiveGate(null).gate, 'BLOCKED')
  assert.equal(evaluateLiveGate('回读').gate, 'BLOCKED')
})

test('readbackConsistencyViolations：不一致是失败（可单独取出），格式缺失不算硬矛盾', () => {
  // 一致 → 没有硬矛盾。
  assert.deepEqual(readbackConsistencyViolations(validReadback()), [])
  // 声明的 sha 与正文不符 → 硬矛盾。
  assert.ok(
    readbackConsistencyViolations(validReadback({ content_sha256: 'b'.repeat(64), read_receipt_ref: `lark:minutes+detail:mt_1@sha256:${'b'.repeat(64)}` }))
      .some((violation) => violation.includes('raw_text')),
  )
  // 回执绑定的哈希与 content_sha256 不符 → 硬矛盾。
  assert.ok(
    readbackConsistencyViolations(validReadback({ read_receipt_ref: `lark:minutes+detail:mt_1@sha256:${'0'.repeat(12)}` }))
      .some((violation) => violation.includes('read_receipt_ref')),
  )
  // 重读哈希与 content_sha256 不符 → 硬矛盾。
  assert.ok(
    readbackConsistencyViolations(validReadback({ reread_sha256: 'c'.repeat(64) }))
      .some((violation) => violation.includes('reread_sha256')),
  )
  // 只是「缺证据」（格式不对 / 缺字段）不是硬矛盾：那是降级 FIXTURE 的路径。
  assert.deepEqual(readbackConsistencyViolations(validReadback({ content_sha256: 'deadbeef' })), [])
  assert.deepEqual(readbackConsistencyViolations(validReadback({ read_receipt_ref: undefined })), [])
})

test('parseReadReceipt：只认 lark:minutes+detail:<token>@sha256:<64位hex|前12位>', () => {
  const full = parseReadReceipt(`lark:minutes+detail:mt_1@sha256:${VALID_SHA}`)
  assert.deepEqual(full, {
    minute_token: 'mt_1',
    digest: VALID_SHA,
    digest_length: 64,
    raw: `lark:minutes+detail:mt_1@sha256:${VALID_SHA}`,
  })
  const short = parseReadReceipt(`lark:minutes+detail:mt_1@sha256:${VALID_SHA.slice(0, 12)}`)
  assert.equal(short?.digest_length, 12)
  assert.equal(short?.digest, VALID_SHA.slice(0, 12))

  // 旧形态（只有 revision）/ 大写 hex / token 里带 @ / 非字符串一律 null。
  assert.equal(parseReadReceipt('lark:minutes+detail:mt_1@7'), null)
  assert.equal(parseReadReceipt(`lark:minutes+detail:mt_1@sha256:${'A'.repeat(64)}`), null)
  assert.equal(parseReadReceipt('lark:minutes+detail:mt@x@sha256:' + VALID_SHA), null)
  assert.equal(parseReadReceipt('upload:actor:sha256:abc;file=x'), null)
  assert.equal(parseReadReceipt(undefined), null)
})

test('isLiveEligible：只有四样证据齐全才 true，且与违规列表一致', () => {
  assert.equal(isLiveEligible(validReadback()), true)
  assert.deepEqual(liveEligibilityViolations(validReadback()), [])

  for (const overrides of [
    { transport: 'FIXTURE' },
    { transport: 'WEBHOOK_PAYLOAD' },
    { read_receipt_ref: '' },
    { read_receipt_ref: 'lark:minutes+detail:mt_1@7' },
    { fetched_at: '' },
    { content_sha256: '' },
    { content_sha256: 'deadbeef' },
    { reread_sha256: 'c'.repeat(64) },
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

  // 证据快照不抛异常：不可信输入一律给 null/false。
  const evidence = liveGateEvidence(null)
  assert.equal(evidence.transport, null)
  assert.equal(evidence.content_sha256_recomputed, null)
  assert.equal(evidence.raw_text_chars, 0)
  assert.equal(evidence.is_complete, false)
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
  assert.equal(FEISHU_MINUTES_CONTRACT_VERSION, '1.1.0')

  assert.equal(FEISHU_MINUTES_ENDPOINTS['minutes.detail'], '/open-apis/minutes/v1/minutes/{minute_token}')
  assert.equal(FEISHU_MINUTES_ENDPOINTS['minutes.transcript'], '/open-apis/minutes/v1/minutes/{minute_token}/transcript')
  for (const [key, endpoint] of Object.entries(FEISHU_MINUTES_ENDPOINTS)) {
    assert.ok(endpoint.startsWith('/open-apis/'), `${key} 必须是绝对路径形态`)
    const note = FEISHU_MINUTES_ENDPOINT_NOTES[key as keyof typeof FEISHU_MINUTES_ENDPOINTS]
    assert.ok(typeof note === 'string' && note.includes('未核实'), `${key} 必须注明「未核实/骨架占位」`)
  }

  assert.match(FEISHU_LARK_CLI.minutesDetailTranscript, /^minutes \+detail --as user --minute-tokens <tokens> --transcript --output-dir <dir>$/)
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

test('fetchTranscript：无传输层时不取数、不建 artifact、不回声 minute_token', async () => {
  const withToken = createFeishuMinutesAdapter({ env: USER_ENV })
  const blocked = await withToken.fetchTranscript({ minute_token: 'mt_1', external_meeting_id: 'm_1' })
  assert.equal(blocked.kind, 'BLOCKED')
  assert.equal(blocked.creates_artifact, false)
  assert.equal(blocked.error_code, 'AUTH_REQUIRED')
  assert.equal(blocked.blocked_reason, 'TRANSPORT_NOT_CONFIGURED')
  assert.notEqual(blocked.labels.connection, 'CONNECTED')
  assert.equal(blocked.labels.provenance, 'FIXTURE')
  assert.equal(blocked.labels.trigger, 'MANUAL')
  assert.deepEqual(blocked.requested, { minute_token_present: true, external_meeting_id_present: true })
  assert.equal('raw_text' in blocked, false, '不得返回正文')
  assert.equal('artifact' in blocked, false, '不得返回伪造 artifact')
  assert.equal('readback' in blocked, false, '没有回读就没有回读对象')
  assert.equal(JSON.stringify(blocked).includes('mt_1'), false, '不得回声 minute_token')

  const invalid = await withToken.fetchTranscript({ external_meeting_id: 'm_1' })
  assert.equal(invalid.kind, 'ERROR')
  assert.equal(invalid.error_code, 'INVALID_ARGS')
  if (invalid.kind === 'ERROR') assert.equal(invalid.reason_code, 'MINUTE_TOKEN_REQUIRED')
  assert.equal(invalid.creates_artifact, false)
  assert.deepEqual(invalid.requested, { minute_token_present: false, external_meeting_id_present: true })

  const noCreds = await createFeishuMinutesAdapter({ env: EMPTY_ENV }).fetchTranscript({ minute_token: 'mt_1' })
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

/**
 * 扫描口径（2026-11-14 修订）：
 *   * **任何**连接器文件都不许自己拼 HTTP / 套接字 / 动态 require —— 传输层只走
 *     Lark CLI，不走 HTTP（`http-transport` 仍在 `not_implemented` 里）；
 *   * **只有** `transport.ts` 允许碰子进程（它是唯一的外部出口），其余文件必须
 *     保持零 I/O：`adapter.ts` 不 import 子进程，传输层靠调用方注入。
 * 这不是「把扫描放宽」：外部出口从「全禁」变成「唯一一处 + 其余仍全禁」，
 * 并且新增断言「只有 transport.ts 一个文件命中 child_process」。
 */
const FORBIDDEN_SOURCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['fetch(', /fetch\s*\(/],
  ['node:http', /node:http/],
  ['node:https', /node:https/],
  ['node:net', /node:net/],
  ['undici', /undici/i],
]

/** 除 `transport.ts` 之外一律禁用的子进程形态。 */
const FORBIDDEN_SUBPROCESS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['child_process', /child_process/],
  ['spawn', /\bspawn\b/i],
  ['execSync', /\bexecSync\b/],
]

/** 唯一允许发起外部调用的文件。 */
const EXTERNAL_EGRESS_FILE = join(CONNECTOR_DIR, 'transport.ts')

/** 列出 `src/connectors/feishu/` 下所有 .ts 文件。 */
async function listConnectorSources(): Promise<string[]> {
  const entries = await readdir(CONNECTOR_DIR, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

test('静态扫描：连接器没有 HTTP / 套接字，子进程只在 transport.ts 一处', async () => {
  const files = await listConnectorSources()
  assert.ok(files.includes(EXTERNAL_EGRESS_FILE), '必须扫到 transport.ts')
  assert.ok(files.length >= 5, `应至少扫到 5 个 .ts 文件（含 transport.ts），实际 ${files.length}`)
  let subprocessFiles = 0
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const [label, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
      assert.equal(pattern.test(text), false, `${file} 命中禁用形态 ${label}`)
    }
    assert.equal(/\brequire\s*\(/.test(text), false, `${file} 不该用 require()`)
    if (file === EXTERNAL_EGRESS_FILE) {
      assert.match(text, /from 'node:child_process'/, 'transport.ts 是唯一允许的子进程出口')
      subprocessFiles += 1
      continue
    }
    for (const [label, pattern] of FORBIDDEN_SUBPROCESS_PATTERNS) {
      assert.equal(pattern.test(text), false, `${file} 命中禁用形态 ${label}（外部出口只许在 transport.ts）`)
    }
  }
  assert.equal(subprocessFiles, 1, '只允许 transport.ts 一个文件碰子进程')
})
