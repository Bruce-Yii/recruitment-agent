// 生产账号运维 CLI 单测：验证 scripts/auth-admin.mjs 生成的 scrypt 串与 credentials.ts 100% 互通。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { isValidPasswordHash, verifyPassword } from '../../src/auth/credentials.ts'
import { buildUpsertUserSql, generateScryptHash } from '../../../../scripts/auth-admin.mjs'

describe('scripts/auth-admin.mjs 生产建号与口令哈希互通性', () => {
  test('generateScryptHash 产出可被 credentials.ts verifyPassword 验证', () => {
    const hash = generateScryptHash('ProdStrong#2026!')
    assert.equal(isValidPasswordHash(hash), true)
    assert.equal(verifyPassword('ProdStrong#2026!', hash), true)
    assert.equal(verifyPassword('WrongPassword!', hash), false)
  })

  test('buildUpsertUserSql 参数校验与 SQL 生成', () => {
    const sql = buildUpsertUserSql({
      tenantId: '00000000-0000-4000-8000-000000000001',
      username: 'Alice.HR',
      displayName: 'Alice',
      alias: 'recruiter',
      password: 'ProdStrong#2026!',
    })
    assert.ok(sql.includes('recruitment.auth_user'))
    assert.ok(sql.includes("'alice.hr'"))
    assert.ok(!sql.includes('ProdStrong#2026!'))

    assert.throws(() =>
      buildUpsertUserSql({
        tenantId: 'not-a-uuid',
        username: 'alice',
        displayName: 'Alice',
        alias: 'recruiter',
        password: 'ProdStrong#2026!',
      }),
    )
    assert.throws(() =>
      buildUpsertUserSql({
        tenantId: '00000000-0000-4000-8000-000000000001',
        username: 'alice',
        displayName: 'Alice',
        alias: 'superuser',
        password: 'ProdStrong#2026!',
      }),
    )
  })
})
