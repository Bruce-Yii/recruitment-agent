// P1-4 认证 Cookie Secure 标记 + P1-5 Webhook SSRF 防护单测。
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { describe, test } from 'node:test'

import { buildClearCookieHeaders, buildLoginCookieHeaders, isHttpsRequest } from '../../src/http/auth.ts'
import { isPrivateOrMetadataHost, validateWebhookUrl } from '../../src/domain/export-webhook.ts'

describe('P1-4 / P1-5 安全加固：HTTPS Secure Cookie 与 Webhook SSRF 防护', () => {
  test('HTTPS / X-Forwarded-Proto=https 自动加 Secure，本地 HTTP 不加', () => {
    const httpsReq = { headers: { 'x-forwarded-proto': 'https' }, socket: {} } as unknown as IncomingMessage
    const httpReq = { headers: {}, socket: {} } as unknown as IncomingMessage
    assert.equal(isHttpsRequest(httpsReq), true)
    assert.equal(isHttpsRequest(httpReq), false)

    const secCookies = buildLoginCookieHeaders(true, 'tok', 'sid-1')
    assert.ok(secCookies.every((c) => c.includes('; Secure')))
    assert.ok(buildClearCookieHeaders(true).every((c) => c.includes('; Secure')))

    const plainCookies = buildLoginCookieHeaders(false, 'tok', 'sid-1')
    assert.ok(plainCookies.every((c) => !c.includes('; Secure')))
  })

  test('Webhook URL：拦截私网/云元数据/内网域名 SSRF，放行公网 https 与显式本地回环测试', () => {
    const blocked = [
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.8/webhook',
      'https://172.16.5.2/hook',
      'https://192.168.1.10/hook',
      'https://127.0.0.1/hook',
      'https://localhost/hook',
      'https://service.internal/hook',
      'https://printer.local/hook',
      'https://[::1]/hook',
      'https://[fe80::1]/hook',
    ]
    for (const url of blocked) {
      assert.throws(() => validateWebhookUrl(url), /SSRF/, `未拦截 SSRF URL: ${url}`)
    }

    assert.equal(isPrivateOrMetadataHost('hooks.example.com'), false)
    assert.equal(validateWebhookUrl('https://hooks.example.com/recruitment'), 'https://hooks.example.com/recruitment')
    assert.equal(validateWebhookUrl('http://127.0.0.1:49999/hook'), 'http://127.0.0.1:49999/hook')
  })
})
