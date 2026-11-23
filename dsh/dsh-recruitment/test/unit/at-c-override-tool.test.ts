// AT-6/7 · 工具层 override 入参校验（纯单测，不需要 DB 口令）。
//
// 关键性质：`createStageAdvanceTool(...).execute()` 里 override 的校验发生在
// `runStageAdvance()`（= createPool / withActor）之前 —— 所以这里的每个负例都是
// "INVALID_ARGS + 零 DB 连接 / 零写入"。用不可达的假配置即可证明：若校验放到了
// 开库之后，这些用例会先撞 ECONNREFUSED 而不是拿到 INVALID_ARGS。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createStageAdvanceTool, unconfiguredStageAdvanceTool } from '../../src/tools/stage-advance.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'

const APP_ID = '11111111-1111-4111-8111-000000000701'
const TENANT = '11111111-1111-4111-8111-000000000001'
/** 故意用不可连的端口：任何走到 createPool 的实现都会先报连接错误。 */
const CFG = {
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'at_c_never_connects',
  password: 'unused',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT,
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 1_000,
  connect_timeout_ms: 1_000,
  max: 1,
} as ResolvedDatabaseConfig

const TOOL = createStageAdvanceTool(CFG)

/** 断言一次 execute 在开库前就被 INVALID_ARGS 拒绝（code + 消息都能机检）。 */
async function rejected(raw: unknown, match: RegExp): Promise<void> {
  await assert.rejects(
    () => TOOL.execute(raw, undefined),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVALID_ARGS', `期望 INVALID_ARGS，实际 ${error.message}`)
      assert.match(error.message, match)
      // 没有连接被创建：报的是参数错误而不是 ECONNREFUSED/timeout。
      assert.doesNotMatch(error.message, /ECONNREFUSED|ETIMEDOUT|connect/i)
      return true
    },
  )
}

test('AT-6 负例：override 缺 confirmation_text → INVALID_ARGS，零写入（开库前）', async () => {
  await rejected(
    { application_id: APP_ID, override: { reason: '面试官临时授权跳过初筛' } },
    /confirmation_text/,
  )
})

test('AT-6 负例：override 缺 reason → INVALID_ARGS，零写入（开库前）', async () => {
  await rejected(
    { application_id: APP_ID, override: { confirmation_text: '我确认跳过这一步' } },
    /reason/,
  )
})

test('AT-6 负例：override 是空对象 / 只有哈希 → INVALID_ARGS', async () => {
  await rejected({ application_id: APP_ID, override: {} }, /reason/)
  await rejected(
    {
      application_id: APP_ID,
      override: {
        reason: 'r',
        confirmation_text: 'c',
        confirmation_text_sha256: 'a'.repeat(64), // 模型自报哈希必须被当作 unknown key 拒绝
      },
    },
    /unknown key.*confirmation_text_sha256/,
  )
})

test('AT-6 负例：reason / confirmation_text 为空白或超长 → INVALID_ARGS', async () => {
  await rejected(
    { application_id: APP_ID, override: { reason: '   ', confirmation_text: 'ok' } },
    /reason.*1\.\.500/,
  )
  await rejected(
    { application_id: APP_ID, override: { reason: 'ok', confirmation_text: '\t\n ' } },
    /confirmation_text.*1\.\.2000/,
  )
  await rejected(
    { application_id: APP_ID, override: { reason: 'x'.repeat(501), confirmation_text: 'ok' } },
    /reason.*1\.\.500/,
  )
  await rejected(
    { application_id: APP_ID, override: { reason: 'ok', confirmation_text: 'x'.repeat(2001) } },
    /confirmation_text.*1\.\.2000/,
  )
})

test('AT-6 负例：override 顶层未知键 / 非对象形状 → INVALID_ARGS', async () => {
  await rejected({ application_id: APP_ID, override: 'reason=c' }, /must be an object/)
  await rejected({ application_id: APP_ID, override: [] }, /must be an object/)
  await rejected({ application_id: APP_ID, override: null }, /must be an object/)
  await rejected({ application_id: APP_ID, actor_id: TENANT }, /actor_id/)
})

test('无 override 时不放宽旧行为：to_stage / 非 UUID 仍 INVALID_ARGS', async () => {
  await rejected({ application_id: APP_ID, to_stage: 'S10' }, /to_stage/)
  await rejected({ application_id: 'not-a-uuid' }, /UUID|uuid/)
  await rejected({}, /application_id/)
})

test('工具名 / 输入 schema：override 可见但可选，required 仍只有 application_id', () => {
  assert.equal(TOOL.name, 'recruitment_application_stage_advance')
  const parameters = TOOL.parameters as Record<string, unknown>
  const properties = parameters.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(properties), ['application_id', 'expected_record_version', 'override'])
  assert.deepEqual(parameters.required, ['application_id'], 'override 绝不进顶层 required')
  assert.equal(parameters.additionalProperties, false)
  // 模型可见文案里必须明写 override 与"哈希由服务端算/未知键拒绝"。
  assert.match(TOOL.description, /OPTIONAL override \(AT-6\/7\)/)
  assert.match(TOOL.description, /confirmation_text_sha256 the model computes.*rejected/)
  assert.match(TOOL.description, /WITHOUT override/)
  assert.match(TOOL.description, /WITH override/)
})

test('AT-6 模型可见性：override schema 是对象、两键 required、都是 string 且有长度上限', async () => {
  const parameters = TOOL.parameters as Record<string, unknown>
  const properties = parameters.properties as Record<string, unknown>
  const override = properties.override as Record<string, unknown>
  assert.equal(override.type, 'object')
  assert.deepEqual(override.required, ['reason', 'confirmation_text'])
  assert.equal(override.additionalProperties, false)

  const overrideProps = override.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(overrideProps), ['reason', 'confirmation_text'])
  assert.equal(overrideProps.reason.type, 'string')
  assert.equal(overrideProps.confirmation_text.type, 'string')

  // DSH 官方原始 JSON Schema 子集不支持 maxLength（只支持 type/oneOf/properties/required/
  // additionalProperties/items/enum/const + description/title/default/examples），
  // 长度上限因此写在 description 里（模型可见），执行期硬校验在 parseOverrideArg。
  assert.match(String(overrideProps.reason.description), /500/)
  assert.match(String(overrideProps.confirmation_text.description), /2000/)
  assert.equal(Object.hasOwn(overrideProps.reason, 'maxLength'), false)
  assert.equal(Object.hasOwn(overrideProps.confirmation_text, 'maxLength'), false)

  // DSH 官方子集校验器必须接受这张 schema（若本机装了 dsh-tools）。
  // DSH_HOME 未设置时本段不适用（CI/Linux 干净检出没有本机 DSH 安装）；
  // 显式有 DSH_HOME 时用 path.join 生成平台无关路径，避免把 Windows 反斜杠塞进 file URL。
  const dshHome = process.env.DSH_HOME
  if (dshHome !== undefined && dshHome !== '') {
    const officialPath = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    try {
      const official = await import(pathToFileURL(officialPath).href) as {
        assertSupportedJsonSchema?: (schema: unknown) => void
      }
      if (typeof official.assertSupportedJsonSchema === 'function') {
        assert.doesNotThrow(() => official.assertSupportedJsonSchema?.(parameters))
      }
    } catch (error) {
      // 官方模块不可用时跳过这一段（本机环境差异），上面的子集断言仍然成立。
      assert.match(String(error), /ENOENT|ERR_MODULE_NOT_FOUND|cannot find|ERR_INVALID_MODULE_SPECIFIER|Invalid module/i)
    }
  }
})

test('未配置替身仍然调用即 NOT_CONFIGURED（override 不改变替身契约）', async () => {
  const tool = unconfiguredStageAdvanceTool(['config.database.host is required'])
  await assert.rejects(
    () => tool.execute({ application_id: APP_ID, override: { reason: 'r', confirmation_text: 'c' } }, undefined),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'NOT_CONFIGURED')
      return true
    },
  )
})
