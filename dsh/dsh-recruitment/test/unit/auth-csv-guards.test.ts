// P1-4 / P1-5 补强单测：production gate 路由覆盖 + CSV 脱敏与公式注入负例。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildApplicationsCsv, maskedContact } from '../../src/domain/export-webhook.ts'
import { EXPORT_PATHS } from '../../src/http/export.ts'
import { ORG_CONFIG_ACTION_PATHS } from '../../src/client/org-config.ts'
import { SETTINGS_PATHS } from '../../src/http/settings.ts'

describe('P1-4 / P1-5 补强：生产路由门禁归属与 CSV 脱敏/公式注入防御', () => {
  test('所有导出 / Webhook / 企业配置 / 设置路由均位于 /recruitment/api/ 受控前缀下（不在公开白名单）', () => {
    const protectedPaths = [
      EXPORT_PATHS.applicationsCsv,
      EXPORT_PATHS.webhookTest,
      ORG_CONFIG_ACTION_PATHS.role,
      ORG_CONFIG_ACTION_PATHS.team,
      ORG_CONFIG_ACTION_PATHS.pipeline,
      SETTINGS_PATHS.read,
      SETTINGS_PATHS.write,
      SETTINGS_PATHS.configOrg,
    ]
    const publicPrefixes = ['/recruitment/login', '/recruitment/api/auth/', '/recruitment/api/public/book', '/recruitment/book']
    for (const p of protectedPaths) {
      assert.ok(p.startsWith('/recruitment/api/'), `受控路由前缀异常：${p}`)
      assert.ok(!publicPrefixes.some((pub) => p.startsWith(pub)), `敏感路由误落入公开白名单：${p}`)
    }
  })

  test('CSV 导出：联系方式强制脱敏 + 公式注入（= / + / - / @）负例全部前缀中和', () => {
    const masked = maskedContact('13812345678', 'alice.wang@example.com')
    assert.ok(!masked.phone.includes('1234'), `手机号未脱敏：${masked.phone}`)
    assert.ok(!masked.email.includes('alice.wang'), `邮箱未脱敏：${masked.email}`)

    const csv = buildApplicationsCsv([
      {
        candidate_name: '=CMD|" /C calc"!A0',
        phone: masked.phone,
        email: masked.email,
        job_title: '+SUM(A1:A2)',
        stage_label: '-2+3',
        screening_label: '@HYPERLINK("http://evil.test")',
        decision_label: '待定',
        updated_at: '2026-11-23',
      },
    ])
    assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV 必须以 UTF-8 BOM 开头')
    // 禁止裸公式单元格直接出现在行首或逗号后
    assert.ok(!/(?:^|,)"?=(?:CMD|HYPERLINK)/m.test(csv), '检测到未中和的 = 公式注入')
    assert.ok(!/(?:^|,)"?\+SUM/m.test(csv), '检测到未中和的 + 公式注入')
    assert.ok(!/(?:^|,)"?-2\+3/m.test(csv), '检测到未中和的 - 公式注入')
    assert.ok(!/(?:^|,)"?@HYPERLINK/m.test(csv), '检测到未中和的 @ 公式注入')
    assert.ok(!csv.includes('证据'), 'CSV 严禁包含禁用词')
  })
})
