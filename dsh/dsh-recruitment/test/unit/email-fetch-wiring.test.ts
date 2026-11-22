// apply() 注册面单测：36 个工具（30 个既有 + email_fetch + criterion_override + candidate_constraint + ui_dispatch + interview_free_slots + workspace_overview），发信只走 HTTP 路由不新增工具。
// 不连真实 IMAP / PG：apply() 只创建工具定义，缺配置时注册 NOT_CONFIGURED 替身。
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../../src/index.ts'
import { EMAIL_FETCH_TOOL } from '../../src/tools/email-fetch.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR_ACTOR = '11111111-1111-4111-8111-000000000103'

/**
 * 假 ctx。`injectWebServer=false`（默认）时 inject 是 no-op——与
 * interview-record-verify.test.ts 的既有做法一致：apply() 只创建工具定义，不注册 HTTP 路由。
 * `injectWebServer=true` 时才递归调用 child，且提供一个最小的 webServer 形状以捕获路由标签；
 * 不需要真实 HTTP 服务（register*Http 在本机 loopback 检查下可能零注册，我们只捕获 effect 标签）。
 */
function fakeCtx(injectWebServer = false) {
  const registered: { name: string; parameters: Record<string, unknown> }[] = []
  const injected: string[] = []
  const effects: string[] = []
  const ctx = {
    webServer: { host: '127.0.0.1', port: 0, register: () => () => {} },
    tools: { register: (tool: { name: string; parameters: Record<string, unknown> }) => registered.push(tool) },
    effect: (fn: () => unknown, label?: string) => {
      effects.push(label ?? '')
      try { return fn() } catch { return undefined }
    },
    inject: (names: readonly string[], cb: (child: unknown) => void) => {
      injected.push(...names)
      if (injectWebServer) cb(ctx)
    },
  }
  return { ctx, registered, injected, effects }
}

test('apply() 注册 37 个工具（30 个既有 + email_fetch + criterion_override + candidate_constraint + ui_dispatch + interview_free_slots + workspace_overview + talent_rediscovery），工具名不重复', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx as never, {
    database: {
      host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra_s6s7',
      tenant_id: TENANT, actor_id: HR_ACTOR,
    },
  }, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })
  const names = registered.map((tool) => tool.name)
  assert.equal(names.length, 37, `注册数必须是 37（30 个既有 + email_fetch + criterion_override + candidate_constraint + ui_dispatch + interview_free_slots + workspace_overview + talent_rediscovery），实际 ${names.length}：${names.join(', ')}`)
  assert.equal(new Set(names).size, 37, '工具名不得重复')
  assert.ok(names.includes(EMAIL_FETCH_TOOL), `注册点少了邮箱收件工具：${names.join(', ')}`)
  assert.ok(names.includes('recruitment_criterion_override'), `注册点少了人工纠偏工具：${names.join(', ')}`)
})

test('mail 未配置时仍注册同名替身，schema 封闭，调用报 NOT_CONFIGURED', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx as never, {
    database: {
      host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra_s6s7',
      tenant_id: TENANT, actor_id: HR_ACTOR,
    },
  }, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })
  const emailTool = registered.find((tool) => tool.name === EMAIL_FETCH_TOOL)
  assert.ok(emailTool)
  assert.equal(emailTool?.parameters.additionalProperties, false)
})

test('mail 配置齐全时注册的工具仍是 37 个；发信只注册 HTTP 路由不新增工具', () => {
  const { ctx, registered, effects } = fakeCtx(true)
  apply(ctx as never, {
    database: {
      host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra_s6s7',
      tenant_id: TENANT, actor_id: HR_ACTOR,
    },
    mail: {
      host: 'imap.example.test', user: 'hr@example.test', password_env: 'RECRUITMENT_MAIL_PASSWORD',
      port: 993, tls: true, folder: 'INBOX', smtp_port: 587, smtp_tls: true,
    },
  }, {
    RECRUITMENT_DB_PASSWORD: 'unused-in-this-test',
    RECRUITMENT_MAIL_PASSWORD: 'unused-in-this-test',
  })
  assert.equal(registered.length, 37, '发信不新增工具')
  assert.equal(registered.filter((tool) => tool.name === EMAIL_FETCH_TOOL).length, 1)
  assert.ok(effects.some((label) => label.includes('email send action route')), '发信 Host Action 路由应在 webServer 注入段注册')
})

test('mail 配置里 ${ENV} 未展开时走替身：工具数仍 37，不因缺配置消失', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx as never, {
    database: {
      host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra_s6s7',
      tenant_id: TENANT, actor_id: HR_ACTOR,
    },
    mail: {
      host: '${RECRUITMENT_MAIL_HOST}', user: '${RECRUITMENT_MAIL_USER}',
      password_env: 'RECRUITMENT_MAIL_PASSWORD', port: 993, tls: true, folder: 'INBOX',
    },
  }, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })
  assert.equal(registered.length, 37)
  assert.equal(registered.filter((tool) => tool.name === EMAIL_FETCH_TOOL).length, 1)
})



