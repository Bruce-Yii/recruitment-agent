// 发信跨模块契约（真链发信卡死根因）：动作把"最终要发的东西"写进 payload，
// pump 直接消费 to/subject/text，不再二次解析收件人；缺字段必须进 FAILED_FINAL/PAYLOAD_INVALID，
// 不许静默抛被 tick().catch(warn) 吞掉 → 永远 PENDING。
// 不连真网/真库：纯函数 round-trip + 假 transport + 假 advance。
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildEmailEffectPayload } from '../../src/connectors/mail/durable-effect.ts'
import {
  parseMailPayload,
  MailPayloadInvalidError,
  createEmailPump,
} from '../../src/runtime/email-pump.ts'
import type { EnqueueEmailSendInput } from '../../src/connectors/mail/durable-effect.ts'
import type { EffectAdvancePatch } from '../../src/connectors/mail/durable-effect.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const TO = 'candidate@example.invalid'
const SUBJECT = '面试邀请 · 测试候选人丁'
const TEXT = '测试候选人丁，您好：这是一封面试邀请，请于周五 14:00 到会议室 A。'

function actionInput(overrides: Partial<EnqueueEmailSendInput> = {}): EnqueueEmailSendInput {
  return {
    tenant_id: '11111111-1111-4111-8111-000000000001',
    actor_id: '11111111-1111-4111-8111-000000000103',
    application_id: '11111111-1111-4111-8111-000000000701',
    recipient_ref: '11111111-1111-4111-8111-000000000901',
    template_key: 'INTERVIEW_INVITE',
    template_version: '1',
    subject: SUBJECT,
    to: TO,
    text: TEXT,
    body_summary: TEXT.slice(0, 500),
    authorization_ref: 'HUMAN_CLICK',
    authorized_by_actor_id: '11111111-1111-4111-8111-000000000103',
    confirmation_text_sha256: 'a'.repeat(64),
    ...overrides,
  }
}

test('round-trip：动作构造的 payload → parseMailPayload → to/subject/text 与原值逐字一致', () => {
  const input = actionInput()
  const payload = buildEmailEffectPayload(input)
  const parsed = parseMailPayload(payload)
  assert.deepEqual(parsed, { to: TO, subject: SUBJECT, text: TEXT })
  // 审计字段仍在（不删）
  assert.equal(payload.authorization_ref, 'HUMAN_CLICK')
  assert.equal(payload.template_key, 'INTERVIEW_INVITE')
  assert.equal(payload.confirmation_text_sha256, 'a'.repeat(64))
})

test('round-trip：授权自动入口的 payload（带 authorization_ref + email_class）也能被 pump 消费', () => {
  const payload = buildEmailEffectPayload(actionInput({
    authorization_ref: 'auth-42',
    authorized_by_actor_id: '11111111-1111-4111-8111-000000000103',
    email_class: 'INTERVIEW_NOTICE',
  }))
  assert.deepEqual(parseMailPayload(payload), { to: TO, subject: SUBJECT, text: TEXT })
})

test('负例：payload 缺 text（只有 body_summary）→ MailPayloadInvalidError(PAYLOAD_INVALID)，不 fallback', () => {
  const input = actionInput()
  const payload = buildEmailEffectPayload(input) as Record<string, unknown>
  delete payload.text
  assert.throws(
    () => parseMailPayload(payload),
    (error: unknown) => error instanceof MailPayloadInvalidError && error.code === 'PAYLOAD_INVALID',
  )
})

test('负例：payload 缺 to → PAYLOAD_INVALID（不猜收件人）', () => {
  const payload = buildEmailEffectPayload(actionInput()) as Record<string, unknown>
  delete payload.to
  assert.throws(
    () => parseMailPayload(payload),
    (error: unknown) => error instanceof MailPayloadInvalidError && error.code === 'PAYLOAD_INVALID',
  )
})

test('pump 负例：payload 缺 text → FAILED_FINAL/PAYLOAD_INVALID，绝不久留 PENDING', async () => {
  const broken = buildEmailEffectPayload(actionInput()) as Record<string, unknown>
  delete broken.text
  const patches: EffectAdvancePatch[] = []
  let sendCalls = 0
  const database = {
    host: '127.0.0.1', port: 1, user: 'x', database: 'x', password: 'x', password_env: 'PW',
    tenant_id: 't', actor_id: 'a', statement_timeout_ms: 1, connect_timeout_ms: 1, max: 1,
  } as ResolvedDatabaseConfig
  const mail = {
    host: 'smtp.test', user: 'hr@test', password_env: 'PW', password: 'x',
    port: 587, tls: false, folder: 'INBOX', since_days: 7, since_uid: 0,
  } as MailConfig
  const pump = createEmailPump({
    database, mail,
    transport: async () => { sendCalls += 1; return { messageId: 'never' } },
    io: {
      claim: async () => [{
        id: 'effect-1', status: 'CLAIMED', payload: broken,
        attempt_count: 0, max_attempts: 5, external_id: '', sent_at: null,
      }] as never,
      listForReadback: async () => [],
      withWrite: async (fn) => fn(undefined),
      advance: async (_client, id, patch) => {
        patches.push({ ...patch })
        return { id, status: patch.status, record_version: 2 }
      },
    },
  })
  const counts = await pump.tick()
  assert.equal(sendCalls, 0, 'payload 不合法绝不发送')
  assert.equal(counts.failed, 1)
  assert.equal(patches[0]?.status, 'FAILED_FINAL')
  assert.equal(patches[0]?.error_code, 'PAYLOAD_INVALID')
  assert.equal(patches.some((p) => p.status === 'PENDING'), false)
  pump.dispose()
})
