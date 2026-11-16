// `business-read.ts` render 文案回归（O1）——**不连库**：只锁"模型读到的人话"。
//
// 病根（真会话 `session-abb9ef68-7ae7-406a-8382-c4345a3642e8`，HEAD `72995b7` 复验）：
//   * `recruitment_application_get` 的 render 里 `application <完整 UUID> @ S7` 被 Agent 原样写成
//     `申请号 11111111-1111-4111-8111-000000000701`（违反 persona "Never show internal identifiers"）；
//   * `recruitment_material_read` 的 render 里 `field_locators: name=absent` 被 Agent 写成
//     `下一步：确认候选人姓名后更新结构化结果`（把"系统没读出的姓名"变成 HR 待办）。
//
// 本文件只锁 render 文本口径：
//   1. 人读正文不再出现完整 UUID / 64 位 hex（机器参数区 `next tools` 例外：模型必须原样复制 args 才能调下游工具）；
//   2. 申请行给业务标识（候选人显示名 + 岗位 code/title + 阶段码），显示名为空才回到短号 `…0701`；
//   3. 材料字段三态改成"材料事实"陈述，不出现"补录 / 检查结构化结果 / 更新结构化结果 / 请 HR 核对并更新"；
//   4. **结构化字段与值保持原样**（`application_id` / `candidate_id` / `rubric_version_id` /
//      `resume_version_id` / `sha256` / `field_locators`），下游与机检仍拿完整值。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  APPLICATION_GET_TOOL,
  MATERIAL_READ_TOOL,
  createBusinessReadTools,
} from '../../src/tools/business-read.ts'

/** 任意依赖（本文件不连库；工厂只保存引用，调用才建池）。 */
const FAKE_CONFIG = {
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'ra_fix_render',
  password: 'render-test-only',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
} as never

const APPLICATION_ID = '11111111-1111-4111-8111-000000000701'
const CANDIDATE_ID = '11111111-1111-4111-8111-000000000601'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const RESUME_VERSION_ID = '7523f5e5-f271-4886-ad0d-e8b78be37fdf'
const ASSET_ID = '546ddbfc-b8d4-4c0d-a396-2fefcb200613'
const ASSET_SHA = '3c12527f6aba0b2ac81702375eaee63e47d4cacb3a5573af09bb85f198eaca24'
const CONTENT_SHA = '290d1a710a80a8c6c62f8b153bf6298ac992ab480d9841601717bd79ff58d1df'

/** UUID 文本模式（8-4-4-4-12）。 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
/** 长 hex（32+，sha256 等）。 */
const HASH_RE = /\b[0-9a-f]{32,64}\b/i
/** O1 明令禁止的"让 HR 补系统数据"措辞。 */
const TODO_RE = /补录|检查结构化结果|更新结构化结果|请 ?HR ?核对并更新/

/** 一条申请的完整规范值（形状与真库 0701 一致；只用于 render）。 */
function applicationValue(displayName = '演示候选人-张样例') {
  return {
    application_id: APPLICATION_ID,
    stage_code: 'S7',
    lifecycle_status: 'ACTIVE',
    record_version: 3,
    candidate: {
      candidate_id: CANDIDATE_ID,
      display_name: displayName,
      identity_status: 'ACTIVE',
      contacts: { visible: false, email: 'z***@demo-recruitment.test', phone: '861****0000' },
    },
    job: { job_id: JOB_ID, code: 'DEMO-BE-001', title: '后端工程师（演示）', status: 'OPEN' },
    rubric: {
      rubric_version_id: RUBRIC_ID,
      version_no: 1,
      source: 'APPLICATION_PIN',
      approved: true,
      criteria_count: 3,
    },
    material: {
      resume_version_id: RESUME_VERSION_ID,
      parse_status: 'PARSED',
      pages: 1,
      issue_count: 0,
      hard_issue_codes: [],
      source_asset_sha256: ASSET_SHA,
      content_sha256: CONTENT_SHA,
      asset: {
        intake_asset_id: ASSET_ID,
        file_name: 'demo-candidate-0701.rtf',
        mime_type: 'application/rtf',
        byte_size: 516,
        sha256: ASSET_SHA,
        validation_status: 'VALID',
      },
    },
    interviews: {
      count: 2,
      items: [
        {
          interview_id: '11111111-1111-4111-8111-000000000801',
          round_no: 1,
          slot_code: 'DEFAULT',
          stage_code: 'S8',
          status: 'POST_INTERVIEW',
        },
        {
          interview_id: '11111111-1111-4111-8111-000000000802',
          round_no: 2,
          slot_code: 'DEFAULT',
          stage_code: 'S8',
          status: 'SCHEDULED',
        },
      ],
    },
    transcripts: { count: 0, ready_count: 0 },
    evaluations: {
      scorecard_count: 3,
      submitted_count: 0,
      scorecards_required_total: 3,
      scorecards_submitted_total: 0,
      scorecards_waived_total: 0,
      scorecards_pending_total: 3,
    },
    rubric_remediation: {
      code: 'CONTINUE_WITH_PINNED',
      message: '申请钉住的评分标准 v1 已批准：按钉住版本继续，不需要再处理其它版本。',
      rebind_action_available: false,
    },
    decisions: { count: 0 },
  }
}

/** 一次申请查询的规范值（列表/单条可覆盖 query）。 */
function applicationGetValue(
  displayName = '演示候选人-张样例',
  query: Record<string, unknown> = { mode: 'LIST', matched: 1, limit: 10, candidate_name: '张样例' },
  application: Record<string, unknown> = {},
) {
  return {
    tool: APPLICATION_GET_TOOL,
    contract_version: '1.0.0',
    tool_kind: 'READ_ONLY',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    query,
    needs_human_choice: false,
    applications: [{ ...applicationValue(displayName), ...application }],
    next_tools: [
      {
        name: 'recruitment_material_read',
        reason: 'Read the bound material.',
        args_json: JSON.stringify({ application_id: APPLICATION_ID, mode: 'SUMMARY' }),
      },
      {
        name: 'recruitment_job_get',
        reason: 'Full job description.',
        args_json: JSON.stringify({ job_id: JOB_ID }),
      },
      {
        name: 'recruitment_interview_get',
        reason: 'Per-interview facts.',
        args_json: JSON.stringify({ application_id: APPLICATION_ID }),
      },
    ],
  }
}

/** 一份材料的完整规范值（`name=absent` 与真库 0701 一致）。 */
function materialReadValue() {
  return {
    tool: MATERIAL_READ_TOOL,
    contract_version: '1.0.0',
    tool_kind: 'READ_ONLY',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    query: {
      mode: 'SUMMARY',
      source: 'APPLICATION',
      application_id: APPLICATION_ID,
      resume_version_id: RESUME_VERSION_ID,
    },
    material: {
      meta: {
        resume_version_id: RESUME_VERSION_ID,
        version_no: 1,
        parse_status: 'PARSED',
        pages: 1,
        reader_backend: 'striprtf/0.0.35',
        reader_version: '1.0.0',
        source_asset_sha256: ASSET_SHA,
        content_sha256: CONTENT_SHA,
      },
      asset: {
        intake_asset_id: ASSET_ID,
        file_name: 'demo-candidate-0701.rtf',
        mime_type: 'application/rtf',
        byte_size: 516,
        sha256: ASSET_SHA,
        validation_status: 'VALID',
        storage_ref_kind: 'CONTENT_ADDRESSED',
      },
      structure: {
        field_locators: [
          { field: 'name', state: 'absent', entry_count: 0 },
          { field: 'phone', state: 'present', entry_count: 0, page: 1 },
          { field: 'email', state: 'present', entry_count: 0, page: 1 },
          {
            field: 'work_experience',
            state: 'present',
            entry_count: 2,
            page: 1,
            quote: '2021-2024 Backend Engineer, Demo Commerce Co.',
          },
          { field: 'education', state: 'present', entry_count: 1, page: 1 },
        ],
        entries: [],
        issues: { count: 0, hard_count: 0, hard_codes: [], codes: [] },
      },
      contacts: { visible: false, email: 'z***@demo-recruitment.test', phone: '861****0000' },
    },
    text: {
      mode: 'SUMMARY',
      available: false,
      reason_code: 'NOT_REQUESTED',
      source_chars: 0,
      excerpt_chars: 0,
      truncated: false,
    },
    next_tools: [
      {
        name: 'recruitment_job_get',
        reason: 'Compare this material against the full rubric criteria.',
        args_json: JSON.stringify({ job_id: JOB_ID }),
      },
      {
        name: 'recruitment_screening_evaluate',
        reason: 'Evaluate the application against the pinned rubric.',
        args_json: JSON.stringify({ application_id: APPLICATION_ID }),
      },
    ],
  }
}

/** 渲染并取纯文本。 */
function renderOf(toolIndex: number, value: unknown): string {
  const tool = createBusinessReadTools({ database: FAKE_CONFIG })[toolIndex]
  assert.ok(tool !== undefined)
  return tool.output.render({}, value).map((block) => block.text).join('\n')
}

/**
 * 人读正文 = 去掉 `next tools` 机器参数区（模型要复制 args 才能调下游工具，完整 id 只允许出现在那里）。
 * @param text - 完整 render 文本。
 * @param headerPattern - 机器参数区 header 的匹配。
 * @returns 人读正文行。
 */
function humanText(text: string, headerPattern: RegExp): string {
  const lines = text.split('\n')
  const headerIndex = lines.findIndex((line) => headerPattern.test(line))
  return (headerIndex < 0 ? lines : lines.slice(0, headerIndex)).join('\n')
}

test('application_get：申请行/query 行给人话；人读正文无完整 UUID / 64hex', () => {
  const text = renderOf(0, applicationGetValue())
  // 申请行：候选人显示名 + 岗位 code/title + 阶段码（不再有 application UUID / job UUID）。
  assert.match(text, /申请：演示候选人-张样例 · DEMO-BE-001 后端工程师（演示） · 阶段 S7/)
  // 候选人行：只留业务身份与脱敏联系方式（不再有 candidate UUID）。
  assert.match(text, /候选人：演示候选人-张样例 identity_status=ACTIVE contacts=/)
  // rubric / 材料：版本号与短号，不再回显完整 UUID 或 64hex。
  assert.match(text, /rubric: v1 \(source=APPLICATION_PIN, approved=true, criteria=3, 版本号 …0403\)/)
  assert.match(text, /material: resume_version=…7fdf parse_status=PARSED pages=1 hard_issues=0/)
  assert.match(text, /asset: …0613 demo-candidate-0701\.rtf 516B sha256=3c12527f… \(VALID\)/)
  // 人读正文（机器参数区之前）没有任何完整 UUID / 64hex。
  const human = humanText(text, /^next tools \(machine arguments/)
  assert.doesNotMatch(human, UUID_RE)
  assert.doesNotMatch(human, HASH_RE)
  // 机器参数区仍然保留完整 args（否则模型无法调 recruitment_material_read 等下游工具）。
  assert.match(text, /next tools \(machine arguments/)
  assert.match(text, /"application_id":"11111111-1111-4111-8111-000000000701"/)
})

test('application_get：单条查询的 query 行用短号（…0701）而不是 application_id=<UUID>', () => {
  const text = renderOf(
    0,
    applicationGetValue('演示候选人-张样例', { mode: 'ONE', matched: 1, limit: 1, application_id: APPLICATION_ID }),
  )
  assert.match(text, /query: ONE matched=1 申请=…0701/)
  assert.doesNotMatch(text.split('\n')[1] ?? '', /application_id=/)
})

test('application_get：显示名为空时申请行退回短号（末 4 位），不出现完整 UUID', () => {
  const text = renderOf(0, applicationGetValue(''))
  assert.match(text, /申请 …0701 · DEMO-BE-001 后端工程师（演示） · 阶段 S7/)
  const human = humanText(text, /^next tools \(machine arguments/)
  assert.doesNotMatch(human, UUID_RE)
})

test('material_read：字段三态改成材料事实（不出现补录/更新结构化结果）', () => {
  const text = renderOf(1, materialReadValue())
  // 姓名读不出 = 事实陈述，不是 HR 待办。
  assert.match(text, /姓名：未能从这份材料里读出来（材料事实）/)
  assert.match(text, /电话：已从这份材料里读到/)
  // 不再出现机器键值对式的 field_locators，也没有任何"补数据"指令。
  assert.doesNotMatch(text, /field_locators:/)
  assert.doesNotMatch(text, TODO_RE)
  // 人读正文无完整 UUID / 64hex（resume_version / asset / hashes 都只给短号/短 hash）。
  const human = humanText(text, /^next \(machine arguments/)
  assert.doesNotMatch(human, UUID_RE)
  assert.doesNotMatch(human, HASH_RE)
  assert.match(human, /resume_version=…7fdf/)
  assert.match(human, /sha256=3c12527f…/)
  assert.match(human, /content_sha256=290d1a71…/)
})

test('结构化字段与值保持原样（下游/机检依赖；本 lane 只改 render 文本）', () => {
  const application = applicationGetValue()
  const app = application.applications[0]
  assert.equal(app?.application_id, APPLICATION_ID)
  assert.equal(app?.candidate.candidate_id, CANDIDATE_ID)
  assert.equal(app?.rubric?.rubric_version_id, RUBRIC_ID)
  assert.equal(app?.material?.resume_version_id, RESUME_VERSION_ID)
  assert.equal(app?.material?.asset?.sha256, ASSET_SHA)
  assert.equal(application.query.application_id, undefined)
  assert.deepEqual(application.next_tools[0]?.args_json, JSON.stringify({ application_id: APPLICATION_ID, mode: 'SUMMARY' }))

  const material = materialReadValue()
  assert.equal(material.query.application_id, APPLICATION_ID)
  assert.equal(material.query.resume_version_id, RESUME_VERSION_ID)
  assert.equal(material.material.asset.sha256, ASSET_SHA)
  // 三态原样（name=absent）——render 的人话不改变结构化结论。
  assert.deepEqual(material.material.structure.field_locators[0], {
    field: 'name',
    state: 'absent',
    entry_count: 0,
  })
})
