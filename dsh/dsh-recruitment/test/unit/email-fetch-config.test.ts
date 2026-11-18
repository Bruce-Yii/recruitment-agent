// recruitment_email_fetch 配置 / 入参契约 / render 脱敏单测（不连网、不连库）。
//
// 守什么：
//   1. resolveMailConfig 缺 host/user/password_env/端口/tls/folder 任一 → resolved=null；
//   2. bundle patch 的普通字符串不做 ${ENV} 插值：未展开形态按缺失处理（fail-closed）；
//   3. 工具 parameters 是封闭对象根，拒绝 host / user / password / folder / tenant_id / actor_id；
//   4. 未配置替身调用即 NOT_CONFIGURED（schema 不漂移）；
//   5. render 人读正文只含短号 / 业务标识，不含完整 UUID / 64 位 hash / 邮件正文 / PII。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMAIL_FETCH_TOOL,
  createEmailFetchTool,
  expandMailEnv,
  resolveMailConfig,
  unconfiguredEmailFetchTool,
} from '../../src/tools/email-fetch.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { ResolvedMailConfig } from '../../src/tools/email-fetch.ts'

const FULL_ENV = {
  RECRUITMENT_MAIL_HOST: 'imap.example.test',
  RECRUITMENT_MAIL_USER: 'hr@example.test',
  RECRUITMENT_MAIL_PASSWORD: 'not-a-real-password',
}

const GOOD_CONFIG = {
  host: '${RECRUITMENT_MAIL_HOST}',
  user: '${RECRUITMENT_MAIL_USER}',
  password_env: 'RECRUITMENT_MAIL_PASSWORD',
  port: 993,
  tls: true,
  folder: 'INBOX',
  smtp_port: 587,
  smtp_tls: true,
}

const FULL_JOB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const FULL_SHA = 'f'.repeat(64)

function fakeDeps(): {
  database: ResolvedDatabaseConfig
  converter: ResolvedConverterConfig
  mail: ResolvedMailConfig
} {
  return {
    database: {
      host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra_s6s7', password: 'x',
      password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: 't', actor_id: 'a',
      statement_timeout_ms: 1000, connect_timeout_ms: 1000, max: 2,
    },
    converter: { python_bin: 'python', converter_dir: '/tmp', allowed_roots: ['/tmp'], timeout_ms: 1000 },
    mail: resolveMailConfig(GOOD_CONFIG, FULL_ENV).resolved as ResolvedMailConfig,
  }
}

test('resolveMailConfig 展开 ${ENV} 后齐全 → resolved，since_days 默认 7', () => {
  const result = resolveMailConfig(GOOD_CONFIG, FULL_ENV)
  assert.equal(result.resolved !== null, true, `应解析成功：${result.issues.join('; ')}`)
  assert.equal(result.resolved?.host, 'imap.example.test')
  assert.equal(result.resolved?.user, 'hr@example.test')
  assert.equal(result.resolved?.password, 'not-a-real-password')
  assert.equal(result.resolved?.since_days, 7)
  assert.equal(result.resolved?.since_uid, 0)
})

test('resolveMailConfig 缺 host / user / password_env / port / tls / folder 任一 → resolved=null', () => {
  const cases: Record<string, unknown> = {
    host: '', user: '', password_env: '', port: undefined, tls: undefined, folder: '',
  }
  for (const [key, bad] of Object.entries(cases)) {
    const result = resolveMailConfig({ ...GOOD_CONFIG, [key]: bad }, FULL_ENV)
    assert.equal(result.resolved, null, `${key} 缺失必须 fail-closed`)
    assert.ok(result.issues.length > 0)
  }
})

test('resolveMailConfig 未展开 ${ENV}（未定义/空白）→ NOT_CONFIGURED，绝不当真实 host', () => {
  const result = resolveMailConfig(
    { ...GOOD_CONFIG, host: '${RECRUITMENT_MAIL_HOST}' },
    { ...FULL_ENV, RECRUITMENT_MAIL_HOST: undefined },
  )
  assert.equal(result.resolved, null)
  assert.match(result.issues.join('; '), /host/)
  const literal = resolveMailConfig({ ...GOOD_CONFIG, host: '${LITERAL_UNSET}' }, FULL_ENV)
  assert.equal(literal.resolved, null)
})

test('expandMailEnv 单遍展开，不递归；未定义变量替换为空串', () => {
  assert.equal(expandMailEnv('${A}/${B}', { A: 'x', B: 'y' }), 'x/y')
  assert.equal(expandMailEnv('${MISSING}', {}), '')
  assert.equal(expandMailEnv('${A}', { A: '${B}', B: 'z' }), '${B}')
})

test('工具入参 schema 封闭：拒绝 host / user / password / folder / tenant_id / actor_id', async () => {
  const tool = createEmailFetchTool({
    ...fakeDeps(),
    transport: {},
    fetch: async () => ({
      total: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0,
      connection: 'CONNECTED', results: [],
    }),
  })
  const params = tool.parameters as Record<string, unknown>
  assert.equal(params.additionalProperties, false)
  assert.deepEqual(Object.keys(params.properties as object).sort(), ['job_id', 'limit', 'since_uid'])
  for (const forbidden of ['host', 'user', 'password', 'folder', 'tenant_id', 'actor_id']) {
    await assert.rejects(
      () => tool.execute({ job_id: FULL_JOB_ID, [forbidden]: 'x' }, {}),
      (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
      `必须拒绝模型传入 ${forbidden}`,
    )
  }
  await assert.rejects(
    () => tool.execute({ job_id: 'not-a-uuid' }, {}),
    (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
  )
  await assert.rejects(
    () => tool.execute({ job_id: FULL_JOB_ID, limit: 51 }, {}),
    (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
  )
  await assert.rejects(
    () => tool.execute({ job_id: FULL_JOB_ID, since_uid: 0 }, {}),
    (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
  )
})

test('未配置替身：同名注册、调用 NOT_CONFIGURED、零写入（fetch 不会被调用）', async () => {
  let called = 0
  const tool = unconfiguredEmailFetchTool(['config.mail.host is required'])
  assert.equal(tool.name, EMAIL_FETCH_TOOL)
  assert.equal((tool.parameters as Record<string, unknown>).additionalProperties, false)
  void called
  await assert.rejects(
    () => tool.execute({ job_id: FULL_JOB_ID }, {}),
    (error: Error & { code?: string }) => error.code === 'NOT_CONFIGURED',
  )
})

test('凭据错（transport kind=AUTH_REQUIRED）→ reject 且 code 精确为 AUTH_REQUIRED，非 NOT_CONFIGURED，零写入', async () => {
  let writes = 0
  // 假 transport 返回 kind='AUTH_REQUIRED'：fetch 抛传输层错误，走 mapFetchError → AUTH_REQUIRED 分支。
  const authError = Object.assign(new Error('bad credentials'), { kind: 'AUTH_REQUIRED' })
  const tool = createEmailFetchTool({
    ...fakeDeps(),
    transport: {},
    fetch: async () => {
      // 真 A 在认证失败时不建池、不写库；这里模拟零写入。
      void writes
      throw authError
    },
  })
  let caught: (Error & { code?: string }) | undefined
  try {
    await tool.execute({ job_id: FULL_JOB_ID }, {})
  } catch (error) {
    caught = error as Error & { code?: string }
  }
  assert.ok(caught, '凭据错必须 reject')
  // 精确相等，不能只 assert.match message。
  assert.equal(caught.code, 'AUTH_REQUIRED')
  assert.notEqual(caught.code, 'NOT_CONFIGURED')
  assert.equal(caught.name, 'RecruitmentToolError')
  assert.match(caught.message, /^AUTH_REQUIRED: /, '错误 message 前缀保持 AUTH_REQUIRED: 不变')
  assert.equal(writes, 0, '零写入')
})

test('没配（resolveMailConfig → null，未配置替身）→ reject 且 code 精确为 NOT_CONFIGURED，非 AUTH_REQUIRED，零写入', async () => {
  let writes = 0
  void writes
  const unconfigured = resolveMailConfig({ ...GOOD_CONFIG, host: '' }, FULL_ENV)
  assert.equal(unconfigured.resolved, null, '前置条件：配置缺项必须解析失败')
  const tool = unconfiguredEmailFetchTool(unconfigured.issues)
  let caught: (Error & { code?: string }) | undefined
  try {
    await tool.execute({ job_id: FULL_JOB_ID }, {})
  } catch (error) {
    caught = error as Error & { code?: string }
  }
  assert.ok(caught, '没配必须 reject')
  // 精确相等，不能只 assert.match message。
  assert.equal(caught.code, 'NOT_CONFIGURED')
  assert.notEqual(caught.code, 'AUTH_REQUIRED')
  assert.equal(writes, 0, '零写入（替身不触发任何 fetch/写入）')
})

test('render 不含完整 UUID / 64 位 hash / 正文 / PII；job_id 完整值只在 machine arguments 区', () => {
  const tool = createEmailFetchTool({
    ...fakeDeps(),
    transport: {},
    fetch: async () => ({ total: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0, connection: 'CONNECTED', results: [] }),
  })
  const value = {
    tool: EMAIL_FETCH_TOOL,
    job_id: FULL_JOB_ID,
    total: 1, ingested: 1, duplicates: 0, skipped: 0, failed: 0,
    connection: 'CONNECTED',
    labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
    results: [{
      message_id: 'abcdef1234567890',
      status: 'INGESTED',
      attachments: [{ filename: 'resume.pdf', sha256_prefix: FULL_SHA.slice(0, 8), outcome: 'INGESTED' }],
      application: { id_suffix: '0701', action: 'CREATED' },
      resume_version: { id_suffix: '9abc', no: 1, action: 'APPENDED' },
      labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
    }],
  }
  const text = tool.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(text, /msg=…7890/)
  assert.match(text, /resume\.pdf/)
  assert.match(text, /ffffffff/)
  assert.match(text, /application=0701/)
  assert.match(text, /resume_version=9abc#1/)
  const [humanPart, machinePart = ''] = text.split(/machine arguments/)
  assert.ok(!humanPart.includes(FULL_JOB_ID), '完整 job_id 不得出现在人读正文')
  assert.ok(!text.includes(FULL_SHA), '完整 sha 不得出现在正文')
  assert.ok(!text.includes('private@personal.example'), 'PII 不得出现在正文')
  assert.match(text, /machine arguments/)
  assert.match(machinePart, new RegExp(`job_id=${FULL_JOB_ID}`), '完整 job_id 只在 machine arguments 区')
})
