// Issue #61：口令哈希的纯函数单测（无 DB / 无 HTTP）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hashPassword,
  isValidPasswordHash,
  normalizeUsername,
  verifyPassword,
} from '../../src/auth/credentials.ts'

/** 迁移 0025 里的两条演示哈希（与 docs/41 的口令一一对应）。 */
const SEED_RECRUITER = 'scrypt$16384$8$1$5f99186ba663a2676f9b3b7899d779bd$713ae9a488f8f32c66e8ecc23db0f935458308153dbc0b02bc31bef9bfe6095cf543c8f016796f159a6f88a20218139326c77c36cb7dc52488984ea8e1b165ec'
const SEED_INTERVIEWER = 'scrypt$16384$8$1$567442441bce8e8b49e878cadee6a893$b65090a6f86ef2066db49f219202ce304321cdd044239a07fabb9cb29db3672961c13bf75a7e532b8d893ba144f7576b920fb2803f135218d8260add0b9ab4a2'

test('迁移种子哈希可验证文档口令，且错误口令失败', () => {
  assert.equal(verifyPassword('Recruiter@2026', SEED_RECRUITER), true)
  assert.equal(verifyPassword('Interviewer@2026', SEED_INTERVIEWER), true)
  assert.equal(verifyPassword('wrong-password', SEED_RECRUITER), false)
  assert.equal(verifyPassword('recruiter@2026', SEED_RECRUITER), false)
})

test('新哈希使用随机盐：同一口令两次哈希不同，且互不混淆', () => {
  const a = hashPassword('A-Strong-Passphrase-2026')
  const b = hashPassword('A-Strong-Passphrase-2026')
  assert.notEqual(a, b)
  assert.equal(isValidPasswordHash(a), true)
  assert.equal(verifyPassword('A-Strong-Passphrase-2026', a), true)
  assert.equal(verifyPassword('A-Strong-Passphrase-2026', b), true)
  assert.equal(verifyPassword('A-Strong-Passphrase-2026!', a), false)
})

test('畸形/篡改的哈希串一律 fail-closed', () => {
  for (const bad of ['', 'plaintext', 'scrypt$1$1$1$00$00', `${SEED_RECRUITER}00`, SEED_RECRUITER.slice(0, -1)]) {
    assert.equal(isValidPasswordHash(bad), false)
    assert.equal(verifyPassword('Recruiter@2026', bad), false)
  }
})

test('用户名归一：小写/去空白，非法字符拒绝', () => {
  assert.equal(normalizeUsername('  Recruiter  '), 'recruiter')
  assert.equal(normalizeUsername('interviewer_a'), 'interviewer_a')
  assert.equal(normalizeUsername('a'), null)
  assert.equal(normalizeUsername('bad name'), null)
  assert.equal(normalizeUsername('__proto__'), '__proto__')
  assert.equal(normalizeUsername(42), null)
})
