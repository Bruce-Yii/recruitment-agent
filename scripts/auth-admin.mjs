#!/usr/bin/env node
// 生产环境账号运维 CLI（复用 dsh-recruitment/src/auth/credentials.ts 同一套 scrypt 参数，零明文落库）。
// 用法：
//   node scripts/auth-admin.mjs hash --password '<强口令>'
//   node scripts/auth-admin.mjs sql-upsert --tenant '<tenant-uuid>' --username 'alice' --name 'Alice' --alias 'recruiter' --password '<强口令>'
import { randomBytes, scryptSync } from 'node:crypto'

export const ALLOWED_ALIASES = new Set(['recruiter', 'interviewer_a', 'interviewer_b'])
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
const SCRYPT_SALT_BYTES = 16

export function generateScryptHash(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new Error('口令长度必须为 8..256 个字符')
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export function buildUpsertUserSql({ tenantId, username, displayName, alias, password }) {
  const normUser = String(username ?? '').trim().toLowerCase()
  if (!/^[a-z0-9._-]{2,64}$/.test(normUser)) {
    throw new Error('用户名仅支持 2..64 位小写字母、数字及 . _ -')
  }
  if (!ALLOWED_ALIASES.has(alias)) {
    throw new Error(`alias 必须是 ${[...ALLOWED_ALIASES].join(' / ')} 之一`)
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tenantId ?? ''))) {
    throw new Error('tenantId 必须是合法 UUID')
  }
  const name = String(displayName ?? '').trim() || normUser
  const hash = generateScryptHash(password)

  return [
    'begin;',
    'insert into recruitment.auth_user (tenant_id, username, password_hash, display_name, alias)',
    `values (${sqlLiteral(tenantId)}::uuid, ${sqlLiteral(normUser)}, ${sqlLiteral(hash)}, ${sqlLiteral(name)}, ${sqlLiteral(alias)})`,
    'on conflict (tenant_id, username) do update set',
    '  password_hash = excluded.password_hash,',
    '  display_name = excluded.display_name,',
    '  alias = excluded.alias,',
    '  disabled_at = null;',
    '-- 首次上线替换完正式账号后，建议取消下方注释以禁用本地演示账号：',
    `-- update recruitment.auth_user set disabled_at = now() where tenant_id = ${sqlLiteral(tenantId)}::uuid and username in ('recruiter', 'interviewer');`,
    'commit;',
  ].join('\n')
}

function parseFlag(argv, name) {
  const idx = argv.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : ''
}

const isMain = process.argv[1] && process.argv[1].endsWith('auth-admin.mjs')
if (isMain) {
  const cmd = process.argv[2]
  try {
    if (cmd === 'hash') {
      const password = parseFlag(process.argv, 'password') || process.env.AUTH_ADMIN_PASSWORD || ''
      console.log(generateScryptHash(password))
    } else if (cmd === 'sql-upsert') {
      const sql = buildUpsertUserSql({
        tenantId: parseFlag(process.argv, 'tenant'),
        username: parseFlag(process.argv, 'username'),
        displayName: parseFlag(process.argv, 'name'),
        alias: parseFlag(process.argv, 'alias') || 'recruiter',
        password: parseFlag(process.argv, 'password') || process.env.AUTH_ADMIN_PASSWORD || '',
      })
      console.log(sql)
    } else {
      console.error('用法: node scripts/auth-admin.mjs <hash|sql-upsert> --password ... [--tenant <uuid> --username <name> --alias recruiter]')
      process.exit(1)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
