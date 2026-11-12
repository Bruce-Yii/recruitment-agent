// 身份解析的纯函数层（不连库）：IR-N1/N2 归一化、IR-G1 闸门、三档结论。
//
// 这个文件守的是**身份红线**（`contracts/identity/identity-resolution-rules.md`）：
//   1. 只有 phone / email 的规范化精确相等才能自动关联；
//   2. 姓名不参与判定（本 lane 口径：D-46→D-52「身份规则简化到三条」）；
//   3. `state != present` 或来源不可自动时，**既不判新人也不判重复**，直接拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  matchByStrongIds,
  normEmail,
  normPhone,
  observeIdentity,
  resolveCandidate,
  type CandidateHit,
  type StrongId,
} from '../../src/db/identity.ts'
import { decideIdentity } from '../../src/tools/application-intake.ts'

test('IR-N1 norm_email：大小写归一（E9），但不做 Gmail 点号折叠、不做 +tag 折叠', () => {
  assert.equal(normEmail('Zhang.San@Example.COM'), 'zhang.san@example.com')
  assert.equal(normEmail('  张三 <zhang.san@example.com>  '), 'zhang.san@example.com')
  assert.equal(normEmail('a.b@gmail.com'), 'a.b@gmail.com', '点号必须保留')
  assert.equal(normEmail('a+tag@example.com'), 'a+tag@example.com', 'tag 必须保留')
  assert.equal(normEmail('not-an-email'), null)
  assert.equal(normEmail('a@b'), null, '没有 TLD 不是邮箱')
  assert.equal(normEmail(undefined), null)
})

test('IR-N2 norm_phone：IR-N2②③④ 与 IR-N4 的 region_ambiguous', () => {
  for (const raw of ['13800001234', '+86 138-0000-1234', '0086 138 0000 1234', '13800001234']) {
    assert.deepEqual(normPhone(raw), { norm: '+8613800001234', region_ambiguous: false }, raw)
  }
  assert.deepEqual(normPhone('13900001111'), { norm: '+8613900001111', region_ambiguous: false })
  // 已知口径边界（照 IR-N2 ④ 的字面顺序实现）：号码只要匹配 `^1[3-9]\d{9}$` 就被当成
  // 国内手机加 `+86`，**不先看国家码**。所以 +1 415... 会被重写成 +86415...。
  // 两侧归一化一致 ⇒ 匹配仍确定；但这是一条应当回抄进 IR 的已知缺陷，不是本实现的自由发挥。
  assert.deepEqual(normPhone('+1 415 555 0100'), { norm: '+8614155550100', region_ambiguous: false })
  // 不匹配国内手机形态、但带显式国际前缀 → 保留 `+`
  assert.deepEqual(normPhone('+44 20 7946 0958'), { norm: '+442079460958', region_ambiguous: false })
  // 裸固话：可能跨城重复 → region_ambiguous=true（IR-N4：不得单独作为自动依据）
  assert.deepEqual(normPhone('01088886666'), { norm: '01088886666', region_ambiguous: true })
  assert.equal(normPhone('abc'), null)
})

test('observeIdentity：present + native_text + 证据齐全 + identity_merge_eligible 才算 AUTO_OK', () => {
  const fields = {
    phone: {
      state: 'present', value: '13800001234', provenance: 'native_text',
      evidence: [{ page: 1, bbox: [1, 2, 3, 4], block: 2, text: '138-0000-1234' }],
    },
    email: {
      state: 'present', value: 'a@example.test', provenance: 'native_text',
      evidence: [{ page: 1, bbox: [1, 2, 3, 4], block: 2, text: 'a@example.test' }],
    },
  }
  const ok = observeIdentity(fields, ['phone', 'email'])
  assert.deepEqual(ok.strong.map((s) => s.field), ['phone', 'email'])
  assert.deepEqual(ok.blocked, [])
  assert.equal(ok.strong[0]?.norm, '+8613800001234')

  // 平台噪声（converter 没把它列进 identity_merge_eligible）→ 不可自动（IR-G6）
  const noise = observeIdentity(fields, [])
  assert.deepEqual(noise.strong, [])
  assert.ok(noise.blocked.some((b) => b.reason === 'not_identity_merge_eligible'))

  // OCR 来源 → 不可自动（IR-G2：即使值完全相等也只能人工）
  const ocr = observeIdentity({
    phone: { ...fields.phone, provenance: 'ocr_title' },
  }, ['phone'])
  assert.deepEqual(ocr.strong, [])
  assert.equal(ocr.blocked[0]?.reason, 'provenance_ocr_title')

  // absent / unreadable → 记 blocked，不是 strong（读不出 ≠ 新人）
  const absent = observeIdentity({ email: { state: 'absent', provenance: 'native_text' } }, [])
  assert.deepEqual(absent.strong, [])
  assert.ok(absent.blocked.some((b) => b.field === 'email' && b.reason === 'field_state_absent'))
  assert.ok(absent.blocked.some((b) => b.field === 'phone' && b.reason === 'field_state_missing'))

  // present 但没有证据坐标 → 不可自动（IR-G1 的 EVID_OK）
  const noEvidence = observeIdentity({
    email: { state: 'present', value: 'a@example.test', provenance: 'native_text', evidence: [] },
  }, ['email'])
  assert.deepEqual(noEvidence.strong, [])
  assert.ok(noEvidence.blocked.some((b) => b.field === 'email' && b.reason === 'evidence_missing'))
})

const PHONE_ID: StrongId = {
  field: 'phone', raw: '13800001234', norm: '+8613800001234', region_ambiguous: false,
  provenance: 'native_text', evidence: [{ page: 1, bbox: [1, 2, 3, 4], block: 1, quote: 'x' }],
}

function hit(candidateId: string, field: 'phone' | 'email'): CandidateHit {
  return {
    candidate_id: candidateId, display_name: 'x', identity_status: 'ACTIVE',
    record_version: 1, field, matched_row_id: candidateId,
  }
}

test('decideIdentity：无命中 → CREATE_CANDIDATE（不打扰人）', () => {
  assert.deepEqual(decideIdentity([PHONE_ID], []), { kind: 'CREATE_CANDIDATE' })
})

test('decideIdentity：恰好一条 → LINK_EXISTING（关联 ≠ 合并）', () => {
  const decision = decideIdentity([PHONE_ID], [hit('c1', 'phone')])
  assert.equal(decision.kind, 'LINK_EXISTING')
  assert.equal(decision.kind === 'LINK_EXISTING' ? decision.hit.candidate_id : '', 'c1')
})

test('decideIdentity：phone 与 email 命中不同档案 → 拒绝（合并必须走合并流程）', () => {
  const decision = decideIdentity([PHONE_ID], [hit('c1', 'phone'), hit('c2', 'email')])
  assert.equal(decision.kind, 'REVIEW')
  assert.equal(decision.kind === 'REVIEW' ? decision.reason_code : '', 'MULTIPLE_STRONG_MATCH')
  const detail = decision.kind === 'REVIEW' ? decision.detail as { blocking_items: unknown[] } : { blocking_items: [] }
  assert.equal(detail.blocking_items.length, 2, 'blocking_items 必须非空且逐条列出')
})

test('decideIdentity：只有 region_ambiguous 的号码 → 拒绝（IR-N4）', () => {
  const ambiguous: StrongId = { ...PHONE_ID, norm: '01088886666', region_ambiguous: true }
  const decision = decideIdentity([ambiguous], [])
  assert.equal(decision.kind, 'REVIEW')
  assert.equal(decision.kind === 'REVIEW' ? decision.reason_code : '', 'REGION_AMBIGUOUS_PHONE')
})

test('decideIdentity：没有任何强标识 → MATERIAL_ATTRIBUTION_UNKNOWN（不得判新人）', () => {
  const decision = decideIdentity([], [])
  assert.equal(decision.kind, 'REVIEW')
  assert.equal(decision.kind === 'REVIEW' ? decision.reason_code : '', 'MATERIAL_ATTRIBUTION_UNKNOWN')
  const detail = decision.kind === 'REVIEW' ? decision.detail as { blocking_items: unknown[] } : { blocking_items: [] }
  assert.equal(detail.blocking_items.length, 1)
})

test('matchByStrongIds / resolveCandidate 需要真库 → 由集成测试覆盖（这里只断言导出存在）', () => {
  assert.equal(typeof matchByStrongIds, 'function')
  assert.equal(typeof resolveCandidate, 'function')
})
