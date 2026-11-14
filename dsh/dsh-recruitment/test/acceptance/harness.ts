// 验收门槛测试的公共底座（**不是**测试文件，文件名不含 .test）。
//
// 本目录把 Notion `08｜Design Audit & Decision Register` 的两组门槛翻成可执行断言：
//   * §11.6 Golden Path 初步验收门槛（8 条）；
//   * §9.12 反事实检查清单（页面当前写作 §9.11，10 条；本套件把「重复/乱序/晚到」
//     拆成两条，凑成任务书要求的 11 条编号）。
//
// 纪律：
//   1. 能连真库的用例一律连 `ra_s6s7`，每个用例在自己的事务里跑并 ROLLBACK（不影响别人）。
//   2. 连不上库直接失败，不许静默 skip（skip ≠ 通过）。
//   3. 测试数据全部合成（合成手机号段 / example.test 邮箱），日志里不出现真实简历内容（R7）。
//   4. 断言看**行数 / 状态 / 证据链**，不看"没抛错"。
import type pg from 'pg'

import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  inRolledBackTx,
  testDatabaseConfig,
  DEMO_JOB,
  DEMO_DEPARTMENT,
  hex64,
  one,
  seedScenario,
  TENANT,
  HR_ACTOR,
  uniqueSuffix,
  type Scenario,
} from '../integration/db.ts'

export {
  createTestPool,
  inRolledBackTx,
  testDatabaseConfig,
  DEMO_JOB,
  DEMO_DEPARTMENT,
  hex64,
  one,
  seedScenario,
  TENANT,
  HR_ACTOR,
  uniqueSuffix,
  type Scenario,
}
export type { DatabaseClient }

/** 已解析的库配置（密码只从环境变量来）。 */
export const cfg = testDatabaseConfig()
/** 共享连接池（各文件各自持有；`after()` 里关闭）。 */
export const pool = createTestPool(cfg)

/** `count(*)::int`，返回 number。 */
export async function count(
  client: DatabaseClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(sql, [...params])
  const n = rows[0]?.n
  if (typeof n !== 'number') throw new Error(`count 查询没有返回数字: ${sql.slice(0, 80)}`)
  return n
}

/** 五张"有业务影响"的表的行数快照（零写入的证明口径，沿用 W3）。 */
export async function tableCounts(client: DatabaseClient): Promise<Record<string, number>> {
  return {
    interview: await count(client, 'select count(*)::int as n from recruitment.interview'),
    interviewer: await count(client, 'select count(*)::int as n from recruitment.interviewer'),
    meeting: await count(client, 'select count(*)::int as n from recruitment.meeting'),
    meeting_binding: await count(client, 'select count(*)::int as n from recruitment.meeting_binding'),
    business_task: await count(client, 'select count(*)::int as n from recruitment.business_task'),
  }
}

/** 断言两次行数快照逐表相等（失败路径必须零写入）。 */
export function assertNoWrites(
  before: Record<string, number>,
  after: Record<string, number>,
  label: string,
): void {
  for (const key of Object.keys(before)) {
    if (after[key] !== before[key]) {
      throw new Error(`${label}：${key} 行数被改写（${before[key]} -> ${after[key]}），失败路径必须零写入`)
    }
  }
}

/** 从契约错误里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
export function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

/** 期望一次调用抛指定 `code`（可选 `reason_code`），返回解析后的 JSON 体。 */
export async function expectToolError(
  run: Promise<unknown>,
  code: string,
  reasonCode?: string,
): Promise<Record<string, unknown>> {
  let thrown: unknown
  try {
    await run
  } catch (error) {
    thrown = error
  }
  if (thrown === undefined) throw new Error(`期望抛 ${code}${reasonCode === undefined ? '' : `(${reasonCode})`}，但调用成功了`)
  const actual = (thrown as { code?: string }).code
  if (actual !== code) throw new Error(`期望 code=${code}，实际 code=${String(actual)}（${String(thrown)}）`)
  const body = errorBody(thrown)
  if (reasonCode !== undefined && body.reason_code !== reasonCode) {
    throw new Error(`期望 reason_code=${reasonCode}，实际 ${String(body.reason_code)}`)
  }
  return body
}

/** 切换事务里的执行身份（`set_config(..., is_local = true)`）。 */
export async function setActor(client: DatabaseClient, actorId: string): Promise<void> {
  await client.query("select set_config('recruitment.actor_id', $1, true)", [actorId])
}

/** 造一条硬性维度（只为让 rubric 合法；大多数验收用例不读它）。 */
export const DIMENSION_WORK_EXISTS = {
  key: 'work_exists',
  label: '有工作经历',
  kind: 'MUST_HAVE',
  weight: 1,
  field: 'work_experience',
  operator: 'EXISTS',
  value: true,
} as const

/** 造一场面试（默认 POST_INTERVIEW，有排期；`ck_interview_scheduled` 要求时刻非空）。 */
export async function addInterview(
  client: DatabaseClient,
  applicationId: string,
  options: { status?: string; roundNo?: number; slotCode?: string } = {},
): Promise<string> {
  return await one(
    client,
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at)
     values ($1, $2, $3, $4, $5, now() - interval '2 days') returning id`,
    [
      TENANT,
      applicationId,
      options.roundNo ?? 1,
      options.slotCode ?? 'DEFAULT',
      options.status ?? 'POST_INTERVIEW',
    ],
  )
}

/** 登记一位面试官（`required=false` 即旁听）。 */
export async function addInterviewer(
  client: DatabaseClient,
  interviewId: string,
  actorId: string,
  requiredScorecard = true,
): Promise<string> {
  return await one(
    client,
    `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, required_scorecard)
     values ($1, $2, $3, $4) returning id`,
    [TENANT, interviewId, actorId, requiredScorecard],
  )
}

/**
 * 造一场面试 + 若干会议 + 各自 active 绑定（S9 转写夹具；与 `test/integration/transcript-import.test.ts` 同形）。
 * 会议一律 MANUAL 绑定、`provider=FEISHU`，时刻取"2 小时前结束"。
 */
export async function seedInterviewWithMeetings(
  client: DatabaseClient,
  applicationId: string,
  roles: readonly string[] = ['PRIMARY'],
): Promise<{ interviewId: string; meetingIds: string[] }> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at)
     values ($1, $2, 1, 'DEFAULT', 'S9', 'POST_INTERVIEW',
             now() - interval '120 minutes', now() - interval '60 minutes')
     returning id`,
    [TENANT, applicationId],
  )
  const interviewId = (rows[0] as { id: string }).id
  const meetingIds: string[] = []
  for (const role of roles) {
    const meetingId = await one(
      client,
      `insert into recruitment.meeting (tenant_id, provider, external_meeting_id, meeting_role, actual_start_at, actual_end_at)
       values ($1, 'FEISHU', $2, $3, now() - interval '120 minutes', now() - interval '60 minutes')
       returning id`,
      [TENANT, `mtg-${uniqueSuffix()}`, role],
    )
    meetingIds.push(meetingId)
    await one(
      client,
      `insert into recruitment.meeting_binding (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
       values ($1, $2, $3, 'MANUAL', $4) returning id`,
      [TENANT, meetingId, interviewId, HR_ACTOR],
    )
  }
  return { interviewId, meetingIds }
}

/** 转写三类行的现有数量（"零写入"的证明用）。 */
export async function transcriptCounts(
  client: DatabaseClient,
  meetingIds: readonly string[],
  interviewId: string,
): Promise<{ artifacts: number; segments: number; records: number }> {
  return {
    artifacts: await count(
      client,
      'select count(*)::int as n from recruitment.transcript_artifact where tenant_id = $1 and meeting_id = any($2::uuid[])',
      [TENANT, [...meetingIds]],
    ),
    segments: await count(
      client,
      `select count(*)::int as n from recruitment.transcript_segment s
         join recruitment.transcript_artifact a on a.id = s.artifact_id and a.tenant_id = s.tenant_id
        where s.tenant_id = $1 and a.meeting_id = any($2::uuid[])`,
      [TENANT, [...meetingIds]],
    ),
    records: await count(
      client,
      'select count(*)::int as n from recruitment.interview_record where tenant_id = $1 and interview_id = $2',
      [TENANT, interviewId],
    ),
  }
}

/** 一条"合成"的转写正文（3 行；不是真实会议内容）。 */
export const SYNTHETIC_TRANSCRIPT = [
  '00:00 面试官：请用两分钟介绍你最近做过的项目。',
  '00:12 候选人：我做过一个合成订单链路，把超时率从 3% 降到 0.2%。',
  '00:30 面试官：具体用了什么手段？',
].join('\n')
