// 写工具的 **Demo Actor 接线机检**（不连库）：
//
//   1. 12 个写工具的工厂都接受可选 `identity`：identity 已装配但 exec 里没有 session 时，
//      `execute()` 必须在**建连/开事务之前**抛 `DEMO_ACTOR_UNMAPPED`（零写入）。
//      这里把库配置指向**未监听的 127.0.0.1:1**：若哪个工具漏了解析，它会以连接错误失败，
//      而不是以 DEMO_ACTOR_UNMAPPED 失败 —— 本测试随即变红（fail-closed 不靠人记得）。
//   2. 兼容口径：不传 identity（既有单测/集成测试）时维持原有 `config.actor_id` 行为，
//      不会被身份解析拦住（预期错误是连接失败，**不是** DEMO_ACTOR_UNMAPPED）。
//   3. 源码机检：12 个写工具文件都必须出现 `resolveWriteActor(`；
//      `scorecard-submit.ts` 的**两处** actor（只读 prepare 的 set_config + 写事务的 withActor）
//      都必须用解析出来的同一个局部量。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ReadonlyToolDefinition } from '../../src/tools/definition.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'
import { PERMISSION_SCOPES } from '../../src/domain/tenant-config.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/resolve.ts'
import { createApplicationIntakeTool } from '../../src/tools/application-intake.ts'
import { createStageAdvanceTool } from '../../src/tools/stage-advance.ts'
import { createInterviewScheduleTool } from '../../src/tools/interview-schedule.ts'
import { createTranscriptImportTool } from '../../src/tools/transcript-import.ts'
import { createScorecardSubmitTool } from '../../src/tools/scorecard-submit.ts'
import { createDecisionRecordTool } from '../../src/tools/decision-record.ts'
import { createJobCreateTool, createJobUpdateTool } from '../../src/tools/job-create.ts'
import { createJobRubricApproveTool } from '../../src/tools/job-rubric-approve.ts'
import { createConfigRoleTool } from '../../src/tools/config-role.ts'
import { createConfigTeamTool } from '../../src/tools/config-team.ts'
import { createConfigPipelineTool } from '../../src/tools/config-pipeline.ts'
import { createInterviewRecordVerifyTool } from '../../src/tools/interview-record-verify.ts'

const APP_ID = '11111111-1111-4111-8111-000000000701'
const DEPARTMENT_ID = '11111111-1111-4111-8111-000000000201'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/**
 * 指向**未监听端口**的库配置：任何"真的想连库"的路径都会立刻连接失败。
 * 于是"应当 fail-closed"的用例只会以 DEMO_ACTOR_UNMAPPED 通过。
 */
const CFG = {
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'ra_d5_w1_never_connect',
  password: 'unused-in-this-test',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 2_000,
  max: 2,
} as ResolvedDatabaseConfig

/** application-intake 的 converter 配置：身份解析在 converter 之前，所以这里只需要一个形状。 */
const CONVERTER = {
  kind: 'cli',
  cli_path: 'C:\\does-not-exist\\converter.exe',
  timeout_ms: 1_000,
} as unknown as ResolvedConverterConfig

/** 一个写工具用例：名字 + 工具定义 + 一次调用的入参。 */
interface WriteToolCase {
  readonly label: string
  readonly source: string
  readonly tool: ReadonlyToolDefinition
  readonly args: unknown
}

/**
 * 12 个写工具（`SET LOCAL recruitment.actor_id` 的全部入口）各造一次。
 * 参数只保证"若身份先通过，能被参数校验接受"；身份必须在参数之前拒绝。
 * @param identity - 已装配的身份（这里故意让注册表为空 = 未绑定）。
 * @returns 用例列表。
 */
function writeToolCases(identity: DemoActorIdentity): readonly WriteToolCase[] {
  return [
    {
      label: 'application_intake',
      source: 'application-intake.ts',
      tool: createApplicationIntakeTool({ converter: CONVERTER, database: CFG }, { identity }),
      args: { path: 'C:\\d5-w1-no-such-resume.pdf', job_id: JOB_ID },
    },
    {
      label: 'stage_advance',
      source: 'stage-advance.ts',
      tool: createStageAdvanceTool(CFG, { identity }),
      args: { application_id: APP_ID },
    },
    {
      label: 'interview_schedule',
      source: 'interview-schedule.ts',
      tool: createInterviewScheduleTool(CFG, { identity }),
      args: {},
    },
    {
      label: 'transcript_import',
      source: 'transcript-import.ts',
      tool: createTranscriptImportTool(CFG, { identity }),
      args: {},
    },
    {
      label: 'scorecard_submit',
      source: 'scorecard-submit.ts',
      tool: createScorecardSubmitTool({ database: CFG, identity }),
      args: {},
    },
    {
      label: 'decision_record',
      source: 'decision-record.ts',
      tool: createDecisionRecordTool({ database: CFG, identity }),
      args: {},
    },
    {
      label: 'job_create',
      source: 'job-create.ts',
      tool: createJobCreateTool(CFG, { identity }),
      args: {},
    },
    {
      label: 'job_update',
      source: 'job-create.ts',
      tool: createJobUpdateTool(CFG, { identity }),
      args: {},
    },
    {
      label: 'job_rubric_approve',
      source: 'job-rubric-approve.ts',
      tool: createJobRubricApproveTool(CFG, { identity }),
      args: {},
    },
    {
      label: 'config_role_create',
      source: 'config-role.ts',
      tool: createConfigRoleTool(CFG, { identity }),
      args: {
        operation: 'create',
        code: 'REVIEWER',
        name: '复核人',
        permission_scopes: [PERMISSION_SCOPES[0]],
      },
    },
    {
      label: 'config_team_create',
      source: 'config-team.ts',
      tool: createConfigTeamTool(CFG, { identity }),
      args: { operation: 'create', code: 'TEAM_X', name: '团队 X', department_id: DEPARTMENT_ID },
    },
    {
      label: 'config_pipeline_create',
      source: 'config-pipeline.ts',
      tool: createConfigPipelineTool(CFG, { identity }),
      args: { operation: 'create', code: 'PIPE_X', name: '流水线 X' },
    },
    {
      label: 'interview_record_verify',
      source: 'interview-record-verify.ts',
      tool: createInterviewRecordVerifyTool(CFG, { identity }),
      args: {},
    },
  ]
}

test('12 个写工具：identity 已装配但 session 未绑定 ⇒ execute 抛 DEMO_ACTOR_UNMAPPED（零连接 / 零写入）', async () => {
  const { identity } = createDemoActorIdentity()
  const cases = writeToolCases(identity)
  assert.equal(cases.length, 13, '12 个工具 = 13 个工具定义（job-create + job-update 各一个）')
  for (const { label, tool, args } of cases) {
    await assert.rejects(
      () => tool.execute(args, undefined),
      (error: unknown) => {
        assert.ok(error instanceof RecruitmentToolError, `${label}: 期望 RecruitmentToolError，实际 ${String(error)}`)
        assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED', `${label}: ${error.message}`)
        return true
      },
    )
  }
})

test('已绑定 session 时身份闸门放行（随后才在建连处失败 —— 证明不是被身份闸门挡住的）', async () => {
  for (const label of ['stage_advance', 'scorecard_submit']) {
    const { identity } = createDemoActorIdentity()
    identity.registry.bind(SESSION_A, 'recruiter')
    const entry = writeToolCases(identity).find((candidate) => candidate.label === label)
    assert.ok(entry !== undefined)
    await assert.rejects(
      () => entry.tool.execute(entry.args, { agent: { id: SESSION_A } }),
      (error: unknown) => {
        assert.notEqual((error as { code?: string }).code, 'DEMO_ACTOR_UNMAPPED', `${label}: 不该再被身份闸门拦住`)
        return true
      },
    )
  }
})

test('兼容口径：不传 identity（既有测试）时维持 config.actor_id 行为，不被身份闸门拦住', async () => {
  const legacy = createStageAdvanceTool(CFG)
  await assert.rejects(
    () => legacy.execute({ application_id: APP_ID }, undefined),
    (error: unknown) => {
      assert.notEqual((error as { code?: string }).code, 'DEMO_ACTOR_UNMAPPED')
      return true
    },
  )
})

test('源码机检：12 个写工具都调用 resolveWriteActor；errors.ts 有 DEMO_ACTOR_UNMAPPED', () => {
  const toolDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools')
  const sources = [
    'application-intake.ts',
    'interview-schedule.ts',
    'transcript-import.ts',
    'scorecard-submit.ts',
    'decision-record.ts',
    'stage-advance.ts',
    'job-rubric-approve.ts',
    'job-create.ts',
    'config-role.ts',
    'config-team.ts',
    'config-pipeline.ts',
    'interview-record-verify.ts',
  ]
  for (const source of sources) {
    const text = readFileSync(join(toolDir, source), 'utf8')
    assert.match(text, /resolveWriteActor\(/, `${source} 必须走统一的写身份解析`)
  }
  const errors = readFileSync(join(toolDir, 'errors.ts'), 'utf8')
  assert.match(errors, /'DEMO_ACTOR_UNMAPPED'/)
})

test('源码机检：scorecard-submit 的**两处** actor（只读 set_config + 写事务 withActor）用同一个解析结果', () => {
  const toolDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools')
  const text = readFileSync(join(toolDir, 'scorecard-submit.ts'), 'utf8')
  // 只读 prepare 事务里的 GUC 用解析后的局部量（不是 cfg.actor_id）。
  assert.match(text, /set_config\('recruitment\.actor_id', \$1, true\)", \[actorId\]/)
  // 写事务的 withActor 用同一个局部量。
  assert.match(text, /withActor\(pool, actorId,/)
  // 两处都不许再直接读配置里的 actor。
  assert.equal(/set_config\('recruitment\.actor_id', \$1, true\)", \[cfg\.actor_id\]/.test(text), false)
  assert.equal(/withActor\(pool, cfg\.actor_id,/.test(text), false)
})
