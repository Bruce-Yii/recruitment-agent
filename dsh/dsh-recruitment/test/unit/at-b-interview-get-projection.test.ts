// AT-4 / AT-5 读投影纯单测（**不连真库**）：`readInterviewValue` 的 stub-client 证据。
//
// 守三条：
//   1. 向后兼容：没有 round_label / 没有替换时，输出里根本没有这两个键（不出现 null/空数组）；
//   2. AT-4：round_label 有值时出现在 interviews[] 元素上，且 round_no 不被改写；
//   3. AT-5：旧行保留并显示 replaced_* 三字段，同时给顶层 replacements 汇总（from/to/reason/time），
//      required_scorecard=false 的旧人不再计入 evaluation.required_scorecards。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  INTERVIEW_VALUE_SCHEMA,
  createInterviewGetTool,
  readInterviewValue,
} from '../../src/tools/interview-get.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import { MACHINE_ARGS_HEADER } from '../../src/tools/render-ref.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR = '11111111-1111-4111-8111-000000000103'
const APP = '11111111-1111-4111-8111-000000000701'
const CANDIDATE = '11111111-1111-4111-8111-000000000801'
const JOB = '11111111-1111-4111-8111-000000000401'
const INTERVIEW = '11111111-1111-4111-8111-000000000501'
const OLD_INTERVIEWER = '11111111-1111-4111-8111-000000000901'
const NEW_INTERVIEWER = '11111111-1111-4111-8111-000000000902'
const FROM = '11111111-1111-4111-8111-000000000104'
const TO = '11111111-1111-4111-8111-000000000102'
const LABEL = '加面 · 交叉评估'
const REPLACED_AT = '2031-01-01T04:00:00.000Z'
const AS_OF = '2031-01-02T00:00:00+08:00'

const CFG: ResolvedDatabaseConfig = {
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: 'not-used-in-unit-tests', password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT, actor_id: HR, statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000, max: 2,
}

interface ProjectionOptions {
  readonly roundLabel?: string | null
  readonly withReplacement?: boolean
}

/** 只读投影的 client 替身（interview-get 是只读工具，替身里没有任何写语句）。 */
function makeClient(options: ProjectionOptions = {}): DatabaseClient {
  const interviewRow = {
    id: INTERVIEW, application_id: APP, candidate_id: CANDIDATE, job_id: JOB,
    round_no: 2, slot_code: 'DEFAULT', round_label: options.roundLabel ?? null,
    stage_code: 'S8', status: 'SCHEDULED', record_version: 4,
    scheduled_start_at: '2031-01-01T02:00:00.000Z',
    scheduled_end_at: '2031-01-01T03:00:00.000Z',
    timezone: 'Asia/Shanghai', status_changed_at: '2031-01-01T02:00:00.000Z',
  }
  const interviewerRows = options.withReplacement === true
    ? [
      {
        interviewer_id: OLD_INTERVIEWER, actor_id: FROM, display_name: '张工',
        role_in_interview: 'INTERVIEWER', required_scorecard: false, scorecard_due_at: null,
        replaced_by_interviewer_id: NEW_INTERVIEWER, replaced_at: REPLACED_AT,
        replacement_reason: '原面试官临时出差',
      },
      {
        interviewer_id: NEW_INTERVIEWER, actor_id: TO, display_name: '李工',
        role_in_interview: 'INTERVIEWER', required_scorecard: true, scorecard_due_at: null,
        replaced_by_interviewer_id: null, replaced_at: null, replacement_reason: null,
      },
    ]
    : [
      {
        interviewer_id: OLD_INTERVIEWER, actor_id: FROM, display_name: '张工',
        role_in_interview: 'INTERVIEWER', required_scorecard: true, scorecard_due_at: null,
        replaced_by_interviewer_id: null, replaced_at: null, replacement_reason: null,
      },
    ]
  return {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      const s = sql.replace(/\s+/g, ' ')
      let rows: unknown[] = []
      if (s.includes('a.candidate_id') && s.includes('from recruitment.interview i')) rows = [interviewRow]
      else if (s.includes('from recruitment.interviewer iv')) rows = interviewerRows
      else if (s.includes("payload ->> 'wait_minutes'")) rows = [{ wait_minutes: '120' }]
      // scorecard / meeting_binding / interview_record 全空。
      return { rows: rows as T[] }
    },
  } as unknown as DatabaseClient
}

/** 递归断言没有 null 值（契约：数据库 NULL 必须省略键）。 */
function assertNoNulls(value: unknown, path = '$'): void {
  if (value === null) assert.fail(`${path} 不能是 null`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNulls(item, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object' && value !== undefined) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) assertNoNulls(child, `${path}.${key}`)
  }
}

// ---------------------------------------------------------------------------

test('向后兼容：无 round_label / 无替换 → 输出里没有这两个键，也没有 null', async () => {
  const value = await readInterviewValue(makeClient(), TENANT, INTERVIEW, AS_OF)
  assert.equal(Object.hasOwn(value, 'round_label'), false)
  assert.equal(Object.hasOwn(value, 'replacements'), false)
  assert.equal(value.round_no, 2)
  for (const interviewer of value.interviewers) {
    assert.equal(Object.hasOwn(interviewer, 'replaced_by_interviewer_id'), false)
    assert.equal(Object.hasOwn(interviewer, 'replaced_at'), false)
    assert.equal(Object.hasOwn(interviewer, 'replacement_reason'), false)
  }
  assertNoNulls(value)
})

test('AT-4：round_label 出现在元素上，round_no / slot_code 不变', async () => {
  const value = await readInterviewValue(makeClient({ roundLabel: LABEL }), TENANT, INTERVIEW, AS_OF)
  assert.equal(value.round_label, LABEL)
  assert.equal(value.round_no, 2)
  assert.equal(value.slot_code, 'DEFAULT')
  assertNoNulls(value)
})

test('AT-5：旧行保留 + replaced_* 三字段 + replacements 汇总；旧人不计入 required_scorecards', async () => {
  const value = await readInterviewValue(makeClient({ roundLabel: LABEL, withReplacement: true }), TENANT, INTERVIEW, AS_OF)
  assert.deepEqual(value.replacements, [{
    from_actor_id: FROM, to_actor_id: TO, reason: '原面试官临时出差', replaced_at: REPLACED_AT,
  }])
  const old = value.interviewers.find((row) => row.actor_id === FROM)
  const fresh = value.interviewers.find((row) => row.actor_id === TO)
  assert.equal(value.interviewers.length, 2, '旧行不删，新人也回显')
  assert.equal(old?.required_scorecard, false)
  assert.equal(old?.replaced_by_interviewer_id, NEW_INTERVIEWER)
  assert.equal(old?.replaced_at, REPLACED_AT)
  assert.equal(old?.replacement_reason, '原面试官临时出差')
  assert.equal(fresh?.required_scorecard, true)
  assert.equal(fresh?.replaced_at, undefined)
  assert.equal(value.evaluation.required_scorecards, 1, '只有新人需要交面评 → 不会被旧人卡住 Evaluation Ready')
  assertNoNulls(value)
})

test('schema：round_label / replacements / 面试官替换三字段都已声明（两个工具共用同一份 schema）', () => {
  const interview = INTERVIEW_VALUE_SCHEMA as {
    properties: Record<string, { type?: string; items?: { properties?: Record<string, unknown> } }>
  }
  assert.equal(interview.properties.round_label?.type, 'string')
  assert.equal(interview.properties.replacements?.type, 'array')
  assert.deepEqual(Object.keys(interview.properties.replacements?.items?.properties ?? {}).sort(),
    ['from_actor_id', 'reason', 'replaced_at', 'to_actor_id'])
  const interviewerItems = interview.properties.interviewers?.items
  assert.deepEqual(Object.keys(interviewerItems?.properties ?? {}).sort(), [
    'interviewer_id', 'actor_id', 'display_name', 'role_in_interview', 'required_scorecard',
    'scorecard_due_at', 'scorecard', 'replaced_by_interviewer_id', 'replaced_at', 'replacement_reason',
  ].sort())
  // schedule 直接复用 INTERVIEW_VALUE_SCHEMA，不需要单独声明。
  const schedule = createInterviewGetTool(CFG) // get 工具构造不连库
  assert.equal(schedule.name, 'recruitment_interview_get')
})

test('render：有值时人读正文显示轮次标签与被替换的面试官（短号，不念完整 UUID）', async () => {
  const value = await readInterviewValue(makeClient({ roundLabel: LABEL, withReplacement: true }), TENANT, INTERVIEW, AS_OF)
  const tool = createInterviewGetTool(CFG)
  const render = tool.output.render as (args: unknown, value: unknown) => { type: string; text: string }[]
  const text = render({}, {
    tool: 'recruitment_interview_get', contract_version: '1.0.0', as_of: AS_OF,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
    query: { mode: 'BY_INTERVIEW', interview_id: INTERVIEW }, count: 1,
    interviews: [value],
  }).map((block) => block.text).join('\n')
  assert.match(text, new RegExp(`轮次标签: ${LABEL}`))
  assert.match(text, /已被替换/)
  assert.match(text, /换人:/)
  // 完整 UUID 只允许出现在末尾的机器参数区；人读正文只给短号。
  const humanPart = text.slice(0, text.indexOf(MACHINE_ARGS_HEADER))
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(humanPart), false)
})
