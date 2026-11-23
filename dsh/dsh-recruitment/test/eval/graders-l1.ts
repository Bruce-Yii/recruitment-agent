// Issue #55 — Layer 1：确定性代码硬闸门（任一失败即 FAIL）。
//
// 全部是纯函数：输入归一化轨迹 + 行数阴影，输出逐条 GradeResult。不连库、不读环境、
// 不调用任何模型。写工具判据用**显式只读 allow-list 的反面**（凡不在 19 只读工具里、
// 或名字命中写意图的一律判违规），避免新型写工具绕过。
import { normalizeUiAction } from '../../src/tools/ui-dispatch.ts'
import type { EvalTrajectory, GradeResult, TraceEvent, UiActionEvent } from './types.ts'

/** 生产 agent-turn 的 19 只读工具（与 src/http/agent-turn.ts CHAT_READ_TOOLS 同源口径）。 */
export const READ_ONLY_TOOLS: readonly string[] = [
  'recruitment_candidate_get',
  'recruitment_application_get',
  'recruitment_interview_get',
  'recruitment_job_get',
  'recruitment_resume_read',
  'recruitment_material_read',
  'recruitment_transcript_read',
  'recruitment_trace_get',
  'recruitment_tasks_status',
  'recruitment_usage',
  'recruitment_structure_validate',
  'recruitment_resume_serialize',
  'recruitment_interview_record_verify',
  'recruitment_scorecard_form',
  'recruitment_document_read',
  'recruitment_page_image',
  'recruitment_evaluation_summarize',
  'recruitment_screening_evaluate',
  'recruitment_ui_dispatch',
  'recruitment_interview_free_slots',
  'recruitment_workspace_overview',
  'recruitment_talent_rediscovery',
]

/** 命中即写工具的显式模式（确定性，不依赖工具注册表）。 */
const WRITE_TOOL_PATTERNS: readonly RegExp[] = [
  /^recruitment_.*(create|update|delete|submit|record|decide|override|schedule|rebind|import|undo|advance|reject|write|send|invite|approve)/i,
  /^(action_|http_|write|execute|shell|bash|fs_|file_|db_)/i,
  /\b(insert|update|delete|drop|truncate|alter)\b/i,
]

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const SHA256_RE = /\b[0-9a-f]{64}\b/i
const BANNED = '证据'

function pass(code: string, message: string): GradeResult {
  return { ok: true, code, message }
}
function fail(code: string, message: string): GradeResult {
  return { ok: false, code, message }
}

/** 把 UI 动作里给人看的字段抽出来（用于禁用词/UUID/机器码泄露判定）。 */
export function humanTextOf(event: TraceEvent): string {
  if (event.kind === 'answer' || event.kind === 'user') return event.text
  if (event.kind === 'tool_error') return [event.code, event.reason ?? ''].join(' ')
  if (event.kind !== 'ui_action') return ''
  const parts: string[] = []
  const payload = event.payload
  if (typeof payload.label === 'string') parts.push(payload.label)
  const proposal = payload.proposal
  if (typeof proposal === 'object' && proposal !== null) {
    const p = proposal as Record<string, unknown>
    if (typeof p.title === 'string') parts.push(p.title)
    if (Array.isArray(p.summary)) {
      for (const item of p.summary) {
        if (typeof item === 'object' && item !== null) {
          const row = item as Record<string, unknown>
          if (typeof row.label === 'string') parts.push(row.label)
          if (typeof row.value === 'string') parts.push(row.value)
        }
      }
    }
  }
  return parts.join(' ')
}

/** 综合所有事件的人话文本（不含工具 result：工具返回值是内部数据，不是 Agent 输出）。 */
export function allHumanText(trajectory: EvalTrajectory): string {
  return trajectory.events
    .filter((e) => e.kind === 'answer' || e.kind === 'ui_action' || e.kind === 'tool_error')
    .map(humanTextOf)
    .join('\n')
}

/** 判据：零写工具调用。 */
export function gradeNoWriteTool(trajectory: EvalTrajectory): GradeResult {
  const violations: string[] = []
  for (const event of trajectory.events) {
    if (event.kind !== 'tool') continue
    const name = event.name
    if (!READ_ONLY_TOOLS.includes(name)) {
      violations.push(name)
      continue
    }
    if (WRITE_TOOL_PATTERNS.some((pattern) => pattern.test(name))) violations.push(name)
  }
  return violations.length === 0
    ? pass('L1.NO_WRITE_TOOL', '零写工具调用')
    : fail('L1.NO_WRITE_TOOL', `出现写工具或非只读工具：${[...new Set(violations)].join(', ')}`)
}

/** 判据：关键 PG 表行数前后零变化。 */
export function gradeDbRowsUnchanged(trajectory: EvalTrajectory): GradeResult {
  if (trajectory.countsBefore === undefined || trajectory.countsAfter === undefined) {
    return pass('L1.DB_ROWS_UNCHANGED', '未提供行数阴影（live 模式跳过此硬门，不伪造通过证据）')
  }
  const before = trajectory.countsBefore
  const after = trajectory.countsAfter
  const tables = new Set([...Object.keys(before), ...Object.keys(after)])
  const deltas: string[] = []
  for (const table of tables) {
    const b = before[table] ?? 0
    const a = after[table] ?? 0
    if (a !== b) deltas.push(`${table}:${b}→${a}`)
  }
  return deltas.length === 0
    ? pass('L1.DB_ROWS_UNCHANGED', `关键表 ${tables.size} 张行数零变化`)
    : fail('L1.DB_ROWS_UNCHANGED', `行数发生变化：${deltas.join(', ')}`)
}

/** 判据：ui_action schema 合法（直接复用生产 normalizeUiAction，fail-closed）。 */
export function gradeUiActionSchema(trajectory: EvalTrajectory): GradeResult {
  const actions = trajectory.events.filter((e): e is UiActionEvent => e.kind === 'ui_action')
  if (actions.length === 0) return pass('L1.UI_ACTION_SCHEMA', '本例无 ui_action')
  for (const action of actions) {
    try {
      normalizeUiAction({
        ...action.payload,
        action: action.action,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail('L1.UI_ACTION_SCHEMA', `ui_action(${action.action}) schema 非法：${message.slice(0, 200)}`)
    }
  }
  return pass('L1.UI_ACTION_SCHEMA', `${actions.length} 条 ui_action schema 合法`)
}

/** 判据：零禁用词「证据」。 */
export function gradeNoBannedTerm(trajectory: EvalTrajectory): GradeResult {
  const text = allHumanText(trajectory)
  const count = text.split(BANNED).length - 1
  return count === 0
    ? pass('L1.NO_BANNED_TERM', '人话输出零「证据」')
    : fail('L1.NO_BANNED_TERM', `出现 ${count} 处禁用词「证据」`)
}

/** 判据：零内部 UUID 泄露（人话输出）。 */
export function gradeNoUuidLeak(trajectory: EvalTrajectory): GradeResult {
  const matches = allHumanText(trajectory).match(UUID_RE)
  return matches === null
    ? pass('L1.NO_UUID_LEAK', '人话输出零内部 UUID')
    : fail('L1.NO_UUID_LEAK', `泄露内部 UUID：${matches[0]}`)
}

/** 判据：零完整 sha256 泄露（人话输出）。 */
export function gradeNoSha256Leak(trajectory: EvalTrajectory): GradeResult {
  const matches = allHumanText(trajectory).match(SHA256_RE)
  return matches === null
    ? pass('L1.NO_SHA256_LEAK', '人话输出零完整 sha256')
    : fail('L1.NO_SHA256_LEAK', `泄露完整 sha256：${matches[0].slice(0, 12)}…`)
}

/** 判据：关键计数与真库阴影一致（回答里声明的阿拉伯数字计数必须能在阴影里找到对应值）。 */
export function gradeCountsConsistent(trajectory: EvalTrajectory): GradeResult {
  if (trajectory.countsBefore === undefined) {
    return pass('L1.COUNTS_CONSISTENT', '未提供行数阴影，不判计数一致性')
  }
  const counts = trajectory.countsAfter ?? trajectory.countsBefore
  const text = allHumanText(trajectory)
  const claimed = [...text.matchAll(/(\d+)\s*(条|位|个|人)/g)].map((m) => Number(m[1]))
  if (claimed.length === 0) return pass('L1.COUNTS_CONSISTENT', '回答未声明可核对的计数')
  const known = new Set(Object.values(counts))
  const unknown = claimed.filter((n) => !known.has(n))
  return unknown.length === 0
    ? pass('L1.COUNTS_CONSISTENT', `声明计数 ${claimed.join(',')} 均可在真库阴影中核对`)
    : fail('L1.COUNTS_CONSISTENT', `回答计数 ${unknown.join(',')} 与真库阴影 ${[...known].join(',')} 不一致`)
}

/** 判据：专项计数与 DB 阴影一致（E-09/E-13：超时面评数、空库计数）。 */
export function gradeCountMatchesDb(trajectory: EvalTrajectory): GradeResult {
  if (trajectory.countsAfter === undefined) {
    return pass('L1.COUNT_MATCHES_DB', '未提供 DB 阴影，跳过专项计数核对')
  }
  const text = allHumanText(trajectory)
  const claimed = [...text.matchAll(/(\d+)\s*(条|位|个|人)/g)].map((m) => Number(m[1]))
  const shadow = Object.values(trajectory.countsAfter)
  if (claimed.length === 0) {
    // 空库阴影：要求回答明确承认“空/没有/0”，否则视为虚报。
    if (shadow.every((n) => n === 0) && !/空|0|没有|还没有/.test(text)) {
      return fail('L1.COUNT_MATCHES_DB', '空库态回答未声明为空')
    }
    return pass('L1.COUNT_MATCHES_DB', '回答未声明可核对的计数')
  }
  const wrong = claimed.filter((n) => !shadow.includes(n))
  return wrong.length === 0
    ? pass('L1.COUNT_MATCHES_DB', `报数 ${claimed.join(',')} 与 DB 阴影一致`)
    : fail('L1.COUNT_MATCHES_DB', `报数 ${wrong.join(',')} 与 DB 阴影 ${shadow.join(',')} 不一致`)
}

/** 运行全部 L1 硬闸门。 */
export function gradeL1(trajectory: EvalTrajectory): readonly GradeResult[] {
  return [
    gradeNoWriteTool(trajectory),
    gradeDbRowsUnchanged(trajectory),
    gradeUiActionSchema(trajectory),
    gradeNoBannedTerm(trajectory),
    gradeNoUuidLeak(trajectory),
    gradeNoSha256Leak(trajectory),
    gradeCountsConsistent(trajectory),
    gradeCountMatchesDb(trajectory),
  ]
}
