// 生产登录的口令哈希（Issue #61 / D-178）。
//
// 纪律：
//   * **永不落明文**：库里只存 `scrypt$N$r$p$salt$hash`；源码里只有迁移种子里的测试夹具哈希，
//     明文口令只在 `docs/41-production-login.md` 里作为演示账号说明出现。
//   * 每次哈希都用 `randomBytes(16)` 随机盐；比对用 `timingSafeEqual`，先做长度检查。
//   * N/r/p 从哈希串里读并钳制在上限内，防止被篡改的库记录把服务拖进超大内存分配。
//   * 本文件是纯函数层（不读 env、不碰 DB、不碰 HTTP）。

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** 默认 scrypt 参数（与迁移 0025 中种子哈希一致）。 */
export const SCRYPT_N = 16_384
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const SCRYPT_KEYLEN = 64
/** 随机盐字节数。 */
export const SCRYPT_SALT_BYTES = 16

const MAX_N = 1 << 16
const MAX_R = 32
const MAX_P = 16

/** 解析后的哈希结构。 */
interface ParsedHash {
  readonly n: number
  readonly r: number
  readonly p: number
  readonly salt: Buffer
  readonly expected: Buffer
}

/** 用随机盐生成一条 `scrypt$N$r$p$salt$hash` 存储串。 */
export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new Error('password must be 8..256 characters')
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const derived = derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** 常量时间比对明文口令与存储串；任何格式异常都返回 false（fail-closed）。 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return false
  const parsed = parseHash(stored)
  if (parsed === null) return false
  let actual: Buffer
  try {
    actual = derive(password, parsed.salt, parsed.n, parsed.r, parsed.p)
  } catch {
    return false
  }
  return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected)
}

/** 存储串必须是 `scrypt$N$r$p$<32 hex>$<128 hex>`，参数在安全上限内。 */
export function isValidPasswordHash(stored: unknown): stored is string {
  return typeof stored === 'string' && parseHash(stored) !== null
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN, { N: n, r, p, maxmem: 128 * n * r + 16 * 1024 * 1024 })
}

function parseHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== 'string') return null
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isSafeInteger(n) || n < 1024 || n > MAX_N || (n & (n - 1)) !== 0) return null
  if (!Number.isSafeInteger(r) || r < 1 || r > MAX_R) return null
  if (!Number.isSafeInteger(p) || p < 1 || p > MAX_P) return null
  if (!/^[0-9a-f]{32}$/.test(parts[4] as string)) return null
  if (!/^[0-9a-f]{128}$/.test(parts[5] as string)) return null
  return {
    n,
    r,
    p,
    salt: Buffer.from(parts[4] as string, 'hex'),
    expected: Buffer.from(parts[5] as string, 'hex'),
  }
}

/** 用户名归一：小写 + 去首尾空白；字符集封闭，杜绝 SQL/路径花招。 */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (!/^[a-z0-9_.-]{2,64}$/.test(value)) return null
  return value
}
