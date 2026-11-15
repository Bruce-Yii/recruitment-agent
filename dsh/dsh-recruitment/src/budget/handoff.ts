// task-78 / DESIGN §3.6：预算超限交接文本（模型可见纯文本，零副作用）。
//
// 机检字面量（必须逐字出现）：`BUDGET_EXCEEDED_HANDOFF` / `task_class=` / `tokens=` /
// `limit_tokens=` / `steps=` / `limit_steps=` / `usage_source=` / `HANDOFF_TO:` /
// `SUGGESTION:` / `STOP`。
//
// 固定前三行（供下游 grep，**不要改动格式**）：
//   BUDGET_EXCEEDED_HANDOFF
//   task_class=<CLASS> tokens=<n> limit_tokens=<n> steps=<n> limit_steps=<n> usage_source=<source> dsh_step=<n|null>
//   STOP
//
// 业务语义（DESIGN §0）：超限时**不写库**，把活交回人——初筛类交 HR，决策类交招聘负责人/approver。
import type { BudgetSnapshot, BudgetTaskClass, ResolvedBudgetConfig } from './types.ts'

export const BUDGET_EXCEEDED_HANDOFF = 'BUDGET_EXCEEDED_HANDOFF'

export interface HandoffInput {
  readonly snapshot: BudgetSnapshot
  readonly config: ResolvedBudgetConfig
}

/** 交接对象按任务类固定（DESIGN §3.6）。 */
const HANDOFF_TARGET: Readonly<Record<BudgetTaskClass, string>> = Object.freeze({
  SCREENING: '人类 HR（Recruiting Workspace → 申请详情 → 初筛）',
  DECISION: '招聘负责人 / approver（正式决策与审批）',
})

const SUGGESTION: Readonly<Record<BudgetTaskClass, string>> = Object.freeze({
  SCREENING:
    '立即停止继续调用工具；把上面已完成的读取结果与本交接文本交给 HR 继续初筛。'
    + '不要绕过预算限制重试、不要拆成多轮绕过上限；需要更多额度请由人调整配置后重新开一轮。',
  DECISION:
    '立即停止继续调用工具；把上面已完成的材料与评估交给招聘负责人 / approver 做正式决策与审批。'
    + '不要绕过预算限制重试、不要拆成多轮绕过上限；需要更多额度请由人调整配置后重新开一轮。',
})

function formatDshStep(value: number | null): string {
  return value === null ? 'null' : String(value)
}

function formatToolsUsed(toolsUsed: Readonly<Record<string, number>>): string {
  const entries = Object.entries(toolsUsed)
  if (entries.length === 0) return '无'
  return entries.map(([name, count]) => `${name}×${count}`).join(', ')
}

function formatOver(snapshot: BudgetSnapshot): string {
  if (snapshot.over.length === 0) return '无（判定为超限但未列出维度，属异常，请人工复核）'
  return snapshot.over
    .map((entry) => `${entry.dimension} used=${entry.used} limit=${entry.limit}`)
    .join('；')
}

function handoffTarget(config: ResolvedBudgetConfig, taskClass: BudgetTaskClass): string {
  const base = HANDOFF_TARGET[taskClass]
  const owner = config.handoff_owner
  if (typeof owner === 'string' && owner.trim() !== '') return `${base}；指定交接人：${owner.trim()}`
  return base
}

/**
 * 生成模型可见的交接文本（三段：做到哪一步 / 交给谁 / 建议）。
 *
 * 纯函数：不读配置源、不读 usage、不写任何东西；同一输入永远同一输出。
 */
export function buildHandoffText(input: HandoffInput): string {
  const { snapshot, config } = input
  const { tokens } = snapshot
  const lines: string[] = []

  // —— 固定前三行（下游 grep 依赖，禁止改格式）——
  lines.push(BUDGET_EXCEEDED_HANDOFF)
  lines.push(
    `task_class=${snapshot.task_class} tokens=${tokens.total} limit_tokens=${snapshot.limits.max_tokens} `
      + `steps=${snapshot.steps} limit_steps=${snapshot.limits.max_steps} `
      + `usage_source=${snapshot.usage_source} dsh_step=${formatDshStep(snapshot.dsh_step)}`,
  )
  lines.push('STOP')
  lines.push('')

  // —— 段一：做到哪一步 ——
  lines.push('做到哪一步：')
  lines.push(
    `- 已放行工具调用 steps=${snapshot.steps}（limit_steps=${snapshot.limits.max_steps}）；`
      + `最近一次工具 last_tool=${snapshot.last_tool === null ? 'null' : snapshot.last_tool}`,
  )
  lines.push(`- tools_used=${formatToolsUsed(snapshot.tools_used)}`)
  lines.push(`- 超出维度：${formatOver(snapshot)}`)
  lines.push(
    `- usage：usage_source=${snapshot.usage_source}，tokens=${tokens.total}（limit_tokens=${snapshot.limits.max_tokens}），`
      + `分桶 uncached_input=${tokens.uncached_input} output=${tokens.output} cache_read=${tokens.cache_read} cache_write=${tokens.cache_write}`,
  )
  // 诚实表述（R3/R4）：闸门只保证**本次被拒调用**未执行；同会话此前已放行的调用
  // 可能已经写库，本闸门不回滚，不能宣称"本轮零写库"。
  lines.push(
    '- 副作用：本次调用被拒绝、工具未执行（本次零写入）；此前已放行的调用不在本闸门回滚范围内。',
  )
  lines.push('')

  // —— 段二：交给谁 ——
  lines.push(`HANDOFF_TO: ${handoffTarget(config, snapshot.task_class)}`)
  // —— 段三：建议 ——
  lines.push(`SUGGESTION: ${SUGGESTION[snapshot.task_class]}`)

  return lines.join('\n')
}
