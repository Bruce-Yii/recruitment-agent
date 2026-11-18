// SMTP 端口/TLS 映射的纯函数单测（不加载 nodemailer、不连真网络）。
//
// 真机口径：QQ IMAP = 993 + implicit TLS；SMTP = 587 + STARTTLS（或 465 + implicit TLS）。
// 若把 IMAP 的 993/tls:true 直接给 nodemailer，会在 993 上做 implicit TLS SMTP → 连接失败。
// 本测试锁死 smtp_* 优先 + 587 强制 STARTTLS 的口径。
import test from 'node:test'
import assert from 'node:assert/strict'

import { smtpTransportOptions } from '../../src/connectors/mail/smtp.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const BASE: MailConfig = {
  host: 'imap.qq.com',
  user: 'me@qq.com',
  password_env: 'RECRUITMENT_MAIL_PASSWORD',
  password: 'never-log-me',
  port: 993,
  tls: true,
  folder: 'INBOX',
}

test('smtp_* 齐全：用 SMTP 端口/TLS/主机，不误用 IMAP 993', () => {
  const options = smtpTransportOptions({
    ...BASE,
    smtp_host: 'smtp.qq.com',
    smtp_port: 587,
    smtp_tls: false,
  })
  assert.equal(options.host, 'smtp.qq.com')
  assert.equal(options.port, 587)
  assert.equal(options.secure, false)
  assert.equal(options.requireTLS, true, '587 必须强制 STARTTLS，绝不降级明文')
})

test('465 隐式 TLS：secure=true、requireTLS=false', () => {
  const options = smtpTransportOptions({ ...BASE, smtp_port: 465, smtp_tls: true })
  assert.equal(options.port, 465)
  assert.equal(options.secure, true)
  assert.equal(options.requireTLS, false)
})

test('没有 smtp_*：回退 IMAP 值（旧调用兼容）', () => {
  const options = smtpTransportOptions(BASE)
  assert.equal(options.host, 'imap.qq.com')
  assert.equal(options.port, 993)
  assert.equal(options.secure, true)
  assert.equal(options.requireTLS, false)
})

test('auth 只含配置里的 user/password，不写进 options 顶层（不泄漏到日志）', () => {
  const options = smtpTransportOptions({ ...BASE, smtp_port: 587, smtp_tls: false }) as {
    auth: { user: string; pass: string }
  }
  assert.deepEqual(options.auth, { user: 'me@qq.com', pass: 'never-log-me' })
  assert.equal((options as Record<string, unknown>).password, undefined)
})
