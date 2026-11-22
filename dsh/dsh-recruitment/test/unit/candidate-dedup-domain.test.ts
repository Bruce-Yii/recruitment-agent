// Issue #36 / G-10 · 候选人去重纯领域函数的单测（不连库、不发 HTTP）。
//
// 覆盖：姓名/手机/邮箱归一化、脱敏、同手机命中、同邮箱命中、不同人不误报、
// 排除自身、跨渠道同名、历史档案线索、命中原因多码、非法 id、纯函数不写入。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compareForDuplicate,
  findDuplicateCandidates,
  isValidApplicationId,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  type DedupCandidateFact,
} from '../../src/domain/candidate-dedup.ts'

function fact(overrides: Partial<DedupCandidateFact> & { applicationId: string }): DedupCandidateFact {
  return {
    applicationId: overrides.applicationId,
    candidateId: overrides.candidateId ?? `cand-${overrides.applicationId}`,
    displayName: overrides.displayName ?? null,
    phone: overrides.phone ?? null,
    email: overrides.email ?? null,
    channelId: overrides.channelId ?? null,
    channelName: overrides.channelName ?? null,
    historyKeys: overrides.historyKeys ?? [],
  }
}

test('G-10 归一化：姓名压空白/去零宽/ASCII 小写；手机邮箱走既有 identity 口径', () => {
  assert.equal(normalizeName('  张\u200B三  '), '张三')
  assert.equal(normalizeName('John  Smith'), 'john smith')
  assert.equal(normalizeName('John-Smith'), 'johnsmith')
  assert.equal(normalizeName('   '), null)

  assert.deepEqual(normalizePhone('+86 138-0013-8000'), { norm: '+8613800138000', regionAmbiguous: false })
  assert.deepEqual(normalizePhone('13800138000'), { norm: '+8613800138000', regionAmbiguous: false })
  assert.deepEqual(normalizePhone('010-12345678'), { norm: '01012345678', regionAmbiguous: true })
  assert.equal(normalizePhone('abc'), null)

  assert.equal(normalizeEmail('  Zhang.San@Example.COM '), 'zhang.san@example.com')
  assert.equal(normalizeEmail('张三 <a@b.com>'), 'a@b.com')
  assert.equal(normalizeEmail('not-an-email'), null)
})

test('G-10 脱敏：手机/邮箱原文不出现在返回值里', () => {
  const phone = maskPhone('+8613800138000')
  assert.equal(phone, '+86 138****8000')
  assert.ok(!phone?.includes('13800138000'))
  const email = maskEmail('Zhang.San@example.com')
  assert.equal(email, 'z***@example.com')
  assert.ok(!email?.includes('zhang.san'))
  assert.equal(maskPhone('bad'), null)
  assert.equal(maskEmail('bad'), null)
})

test('G-10 同手机命中：跨渠道跨投递返回 SAME_PHONE + 脱敏提示（无原文）', () => {
  const subject = fact({ applicationId: 'app-a', phone: '13800138000', email: 'a@x.test', channelId: 'board' })
  const other = fact({
    applicationId: 'app-b',
    candidateId: 'cand-b',
    phone: '+86 138-0013-8000',
    email: 'other@x.test',
    channelId: 'referral',
    displayName: '李四',
  })
  const hits = findDuplicateCandidates(subject, [other])
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].reasons, ['SAME_PHONE'])
  assert.deepEqual(hits[0].matchedKeyKinds, ['phone'])
  assert.ok(hits[0].matchedValueHints.some((hint) => hint.includes('****')))
  const serialized = JSON.stringify(hits)
  assert.ok(!serialized.includes('13800138000'))
  assert.ok(!serialized.includes('+8613800138000'))
})

test('G-10 同邮箱命中：大小写/尖括号归一化后仍命中，仅返回脱敏邮箱', () => {
  const subject = fact({ applicationId: 'app-a', email: 'zhang.san@example.com' })
  const other = fact({ applicationId: 'app-b', candidateId: 'cand-b', email: ' Zhang.San@Example.COM ' })
  const hits = findDuplicateCandidates(subject, [other])
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].reasons, ['SAME_EMAIL'])
  assert.equal(hits[0].matchedValueHints[0], 'z***@example.com')
  assert.ok(!JSON.stringify(hits).includes('zhang.san@example.com'))
})

test('G-10 不同人不误报：姓名/邮箱/手机都不同 → 空数组', () => {
  const subject = fact({
    applicationId: 'app-a', displayName: '张三', phone: '13800138000', email: 'a@x.test', channelId: 'board',
  })
  const others = [
    fact({ applicationId: 'app-b', displayName: '李四', phone: '13900139000', email: 'b@x.test', channelId: 'referral' }),
    fact({ applicationId: 'app-c', displayName: '王五', phone: '13700137000', email: 'c@x.test', channelId: 'board' }),
  ]
  assert.deepEqual(findDuplicateCandidates(subject, others), [])
})

test('G-10 排除自身：同 applicationId / 同 candidateId 都不算命中', () => {
  const subject = fact({ applicationId: 'app-a', candidateId: 'cand-a', phone: '13800138000', email: 'a@x.test' })
  const others = [
    fact({ applicationId: 'app-a', candidateId: 'cand-a', phone: '13800138000', email: 'a@x.test' }),
    fact({ applicationId: 'app-a2', candidateId: 'cand-a', phone: '13800138000', email: 'a@x.test' }),
  ]
  assert.deepEqual(findDuplicateCandidates(subject, others), [])
})

test('G-10 命中原因可多码 + 跨渠道同名 + 历史档案；不删除/不合并历史', () => {
  const subject = fact({
    applicationId: 'app-a', displayName: '张三', phone: '13800138000', email: 'a@x.test',
    channelId: 'board', historyKeys: ['MERGED:cand-old'],
  })
  const other = fact({
    applicationId: 'app-b', candidateId: 'cand-b', displayName: '张\u200B三', phone: '13800138000',
    email: 'A@X.TEST', channelId: 'referral', historyKeys: ['MERGED:cand-old'],
  })
  const hits = findDuplicateCandidates(subject, [other])
  assert.equal(hits.length, 1)
  assert.deepEqual([...hits[0].reasons].sort(), [
    'SAME_EMAIL', 'SAME_HISTORY_ARCHIVE', 'SAME_NAME_SAME_CHANNEL', 'SAME_PHONE',
  ])
  assert.equal(hits[0].applicationId, 'app-b')
  // 纯函数：入参未被修改（不自动合并 / 不删除历史）。
  assert.deepEqual(subject.historyKeys, ['MERGED:cand-old'])
  assert.deepEqual(other.historyKeys, ['MERGED:cand-old'])
})

test('G-10 compareForDuplicate 无命中返回 null；limit 生效', () => {
  const subject = fact({ applicationId: 'app-a', phone: '13800138000' })
  assert.equal(compareForDuplicate(subject, fact({ applicationId: 'app-z', phone: '13900139000' })), null)
  const pool = Array.from({ length: 5 }, (_, i) =>
    fact({ applicationId: `app-${i}`, phone: '13800138000' }))
  assert.equal(findDuplicateCandidates(subject, pool, { limit: 2 }).length, 2)
  assert.equal(findDuplicateCandidates(subject, pool, { limit: 0 }).length, 5) // 非法 limit → 默认 20
})

test('G-10 非法 applicationId fail-closed', () => {
  assert.equal(isValidApplicationId('app-123'), true)
  assert.equal(isValidApplicationId(''), false)
  assert.equal(isValidApplicationId('a/b'), false)
  assert.equal(isValidApplicationId('a\\b'), false)
  assert.equal(isValidApplicationId('a b'), false)
  assert.equal(isValidApplicationId('a\u0000'), false)
  assert.equal(isValidApplicationId(123), false)
})
