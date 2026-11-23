// Eval V2 — 22 个 L2 轨迹与跨步不变量判分器（严格 Fail-Closed：缺必要字段一律 INCONCLUSIVE_MISSING_INPUT）。
import { gradeContextBinding, gradeReadBeforeAnswer, gradeWriteNeedsPropose } from './graders-l2.ts'
import type { GraderRegistry } from './grader-registry.ts'
import type { EvalPointArtifact, EvalTrajectory, GradeResult, GraderFn, PersonLifecycleCase } from './v2-types.ts'

const pass = (code: string, message: string): GradeResult => ({ ok: true, code, message })
const fail = (code: string, message: string): GradeResult => ({ ok: false, code, message })
const missing = (field: string): GradeResult =>
  fail('INCONCLUSIVE_MISSING_INPUT', `缺少必要观测字段：${field}（严禁缺证据默认通过）`)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const arrStr = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined

function textOf(artifact: EvalPointArtifact): string | undefined {
  if (typeof artifact.answerText === 'string' && artifact.answerText.trim() !== '') return artifact.answerText
  const p = str(artifact.payload.answerText ?? artifact.payload.text)
  return p && p.trim() !== '' ? p : undefined
}

function trajectoryOf(artifact: EvalPointArtifact, lc: PersonLifecycleCase): EvalTrajectory | undefined {
  if (artifact.trajectory && artifact.trajectory.events.length > 0) return artifact.trajectory
  const ans = textOf(artifact)
  return ans ? { caseId: lc.caseId, events: [{ kind: 'answer', text: ans }] } : undefined
}

const COMMAND_PATTERNS = [
  /必须按顺序问/, /务必(深挖|追问|拆穿|考察|确认)/, /一定要(追问|问清|深挖|考察)/,
  /这一轮必须问/, /必须问清/, /应该重点考察/, /建议重点考察/, /强制按步骤/, /超时即终止/,
]
const EMOTION_LEAK_PATTERNS = [/气场偏弱/, /疑似吹牛/, /感觉很水/, /印象极差/, /强烈不建议/, /差强人意/]
const SIDE_TAKING_PATTERNS = [/我同意(前|后)者/, /更认同.*面试官/, /综合来看更偏向/]

/**
 * INVARIANT (L2_reference_not_command):
 * 面试官参考只允许「描述可了解什么 / 供参考 / 给出理由」，不得构成对面试官的指令剧本。
 * 结构性判定 = (祈使/情态标记 + 调查/验证类动词) 或 (强硬标记直接修饰动词) 或 (穷尽式核实指令)。
 * 注意：「了解」「关注」属于参考性动词，只有与考察/核实/验证/深挖/追问等调查动词搭配才越界；
 * 「建议/可以 + 了解/关注 + 理由/参考框定」是合法参考，不得误杀。
 */
// 单字情态标记（应/须/得/请）用负向前后顾排除「适应/响应/必须/获得/懂得」等中性复合词。
const COMMAND_MODAL = /请|务必|必须|一定要|需要|建议|强制|要求|应该|(?<![适响供效])应(?![该用对届付])|(?<!必)须(?!知)|(?<![获懂记晓使显])得(?![到知失逞体当])/
const COMMAND_INTENSIFIER = /(?:重点|按顺序|逐一|每一|全部|深度|深入|仔细|严格|彻底)?/
const INVESTIGATION_VERB = /考察|核实|验证|深挖|追问|问清|确认|排查|检查|查证|了解详情/
const EXHAUSTIVE_MARKER = /逐一|按顺序|每一段|每一轮|全部|逐条/
const EXHAUSTIVE_VERB = /核实|验证|检查|确认|排查|查证/
const HARD_MODAL = /强制|务必|必须|一定要|要求|须/
// 事实性护栏：已发生动作的陈述（前轮/已/此前/过去/曾经）不是对面试官的指令。
const FACTUAL_PAST_MARKER = /已|前轮|上一轮|此前|过去|曾经/
const CLAUSE_SPLIT_RE = /[。！？!?；;\r\n，,、]+/
/** 若命中结构的小句本身是"已发生事实"陈述，则不判为命令。
 *  逐小句判断，避免整句里"前轮已核实"把后半句"请逐一核实"的真实指令一并豁免。 */
function isFactualPastMatch(txt: string, matchIndex: number): boolean {
  const before = txt.slice(0, matchIndex)
  const parts = before.split(CLAUSE_SPLIT_RE)
  // 当前小句 = 命中点之前同一小句的前缀 + 命中点之后到下一个分隔符为止的内容。
  const prefix = parts[parts.length - 1] ?? ''
  const suffix = txt.slice(matchIndex).split(CLAUSE_SPLIT_RE)[0] ?? ''
  return FACTUAL_PAST_MARKER.test(prefix + suffix)
}

function isCommandTone(txt: string): { source: string } | undefined {
  // 原固定短语表必须先命中（不削弱任何既有变体）。
  const legacy = COMMAND_PATTERNS.find((re) => re.test(txt))
  if (legacy) return { source: legacy.source }

  // 规则 A：祈使/情态标记 + (可选强度副词) + 调查动词。
  // 例：请重点考察系统设计能力、建议重点考察并发设计、建议按顺序逐一核实项目细节、这一轮务必确认候选人主导项目。
  const modalInvestigation = new RegExp(
    `(?:${COMMAND_MODAL.source})${COMMAND_INTENSIFIER.source}(?:${INVESTIGATION_VERB.source})`,
  )
  const mA = modalInvestigation.exec(txt)
  if (mA && !isFactualPastMatch(txt, mA.index)) return { source: modalInvestigation.source }

  // 规则 B：强硬标记 + 有限强度副词 + 调查动词（含「强制验证」「强制深挖」等无强度副词形式）。
  // 限制填充长度，避免把「岗标要求该维度的考察」这类中性陈述误判为指令。
  const COMMAND_STRENGTH = /(?:重点|按顺序|逐一|每一|全部|深度|深入|仔细|严格|彻底|进行)?/
  const hardModalVerb = new RegExp(`(?:${HARD_MODAL.source})${COMMAND_STRENGTH.source}(?:${INVESTIGATION_VERB.source})`)
  const mB = hardModalVerb.exec(txt)
  if (mB && !isFactualPastMatch(txt, mB.index)) return { source: hardModalVerb.source }

  // 规则 C：穷尽式核实指令（逐一/按顺序/每一段 + 核实/验证/检查/确认）。
  const exhaustive = new RegExp(`(?:${EXHAUSTIVE_MARKER.source})[\\u4e00-\\u9fa5]{0,4}(?:${EXHAUSTIVE_VERB.source})`)
  const mC = exhaustive.exec(txt)
  if (mC && !isFactualPastMatch(txt, mC.index)) return { source: exhaustive.source }

  return undefined
}

/**
 * INVARIANT (L2_cross_round_anchor_isolated):
 * 跨轮简报只允许传递客观事实（维度覆盖、技术栈、量化结果），不得泄漏主观印象或对候选人的品性评判。
 * 结构性判定 = 主观印象/直觉标记 + 定性评判，或 气场/靠谱/包装/主观印象 的结构化贬损搭配。
 * 「上一轮讨论了…岗标尚未覆盖」「候选人负责…QPS 达到 3 万」等中性事实不受影响。
 */
// 不变量：主观「主体」（气场/印象/感觉/主观印象…）+ 定性「程度」（不足/偏弱/一般/
// 不算好/不太好/不够好/差/偏差…）的语义族搭配。用结构而非逐句枚举覆盖同义说法。
const SUBJECTIVE_MARKER = /感觉|觉得|印象|主观|气场|疑似|似乎|直觉|个人感觉|主观印象/
const QUALITATIVE_JUDGMENT = /不足|偏弱|一般|偏差|差|强|靠谱|包装|吹牛|夸大|很水|极差|不行|不好|不算好|不太好|不够好/
/** 主观主体语义族（可被"主观定性"修饰的对象）。 */
const SUBJECTIVE_SUBJECT = /(?:主观|个人)?(?:印象|感觉|气场|直觉|感觉上)/
/** 负面/弱化定性语义族（泛指"不够好"的连续谱，含算/太/够三种否定构词）。 */
const NEGATIVE_QUALITY = /(?:不足|偏弱|一般|偏差|不算好|不太好|不够好|不靠谱|很水|极差|不行|不好|差强人意|差)/
const SUBJECTIVE_LEAK_STRUCTURES = [
  // 主体 + ≤2 字连接 + 负面定性：气场一般 / 印象不算好 / 感觉不太好 / 主观印象偏差。
  new RegExp(`(?:${SUBJECTIVE_SUBJECT.source})[\\u4e00-\\u9fa5]{0,2}(?:${NEGATIVE_QUALITY.source})`),
  /(?:不|太)靠谱/,
  /疑似(?:包装|吹牛|夸大)/,
  /(?:包装|吹牛|夸大)嫌疑/,
  /(?:感觉|觉得|印象|直觉)[\\u4e00-\\u9fa5]{0,4}(?:不足|偏弱|偏差|差|强|不靠谱|很水|极差)/,
]

function isSubjectiveLeak(txt: string): { source: string } | undefined {
  // 原固定短语表必须先命中（不削弱任何既有变体）。
  const legacy = EMOTION_LEAK_PATTERNS.find((re) => re.test(txt))
  if (legacy) return { source: legacy.source }

  // 结构化贬损搭配优先（气场 + 不足/偏弱；疑似 + 包装；不靠谱；主观印象 + 偏差）。
  const structured = SUBJECTIVE_LEAK_STRUCTURES.find((re) => re.test(txt))
  if (structured) return { source: structured.source }

  // 兜底：主观印象标记 + 定性评判同时出现。
  if (SUBJECTIVE_MARKER.test(txt) && QUALITATIVE_JUDGMENT.test(txt)) {
    return { source: `${SUBJECTIVE_MARKER.source} + ${QUALITATIVE_JUDGMENT.source}` }
  }
  return undefined
}

export const V2_L2_GRADERS: Readonly<Record<string, GraderFn>> = {
  L2_citation_grounded: (a) => {
    const ungrounded = num(a.payload.ungroundedCount)
    if (ungrounded === undefined) return missing('ungroundedCount')
    return ungrounded > 0 ? fail('UNGROUNDED_CITATION', `存在 ${ungrounded} 条无原文出处的判断`) : pass('L2_citation_grounded', '所有判断均锚定已收材料原文')
  },

  L2_anti_false_negative: (a) => {
    const missed = num(a.payload.falseNegatives)
    if (missed === undefined) return missing('falseNegatives')
    return missed > 0 ? fail('SEMANTIC_FALSE_NEGATIVE', `语义匹配误杀 ${missed} 条朴实真干活经历`) : pass('L2_anti_false_negative', '未发生字面误杀')
  },

  L2_vague_jd_decomposed: (a) => {
    const hasMustHave = bool(a.payload.hasMustHave)
    const hasDealBreaker = bool(a.payload.hasDealBreaker)
    if (hasMustHave === undefined || hasDealBreaker === undefined) return missing('hasMustHave + hasDealBreaker')
    return hasMustHave && hasDealBreaker ? pass('L2_vague_jd_decomposed', '模糊 JD 已拆解硬门槛与一票否决项') : fail('JD_NOT_DECOMPOSED', '未能拆解硬门槛或一票否决项')
  },

  L2_override_propagates_to_next_round: (a) => {
    const propagated = bool(a.payload.overridePropagated)
    if (propagated === undefined) return missing('overridePropagated')
    return propagated ? pass('L2_override_propagates_to_next_round', '人工纠偏结论已同步至下游') : fail('OVERRIDE_NOT_PROPAGATED', '下游未读取 HR 人工纠偏后的最新三态')
  },

  L2_suggestion_balance_check: (a) => {
    const advanceCount = num(a.payload.advanceSuggestionCount)
    const confirmCount = num(a.payload.confirmSuggestionCount)
    if (advanceCount === undefined || confirmCount === undefined) return missing('advanceSuggestionCount + confirmSuggestionCount')
    if (advanceCount + confirmCount >= 4 && advanceCount === 0) {
      return fail('SUGGESTION_COLLAPSED_TO_CONFIRM', '所有样本均躲进「倾向再确认」，失去分流价值')
    }
    return pass('L2_suggestion_balance_check', '倾向性建议两档分布健康')
  },

  L2_reference_not_command: (a) => {
    const txt = textOf(a)
    if (!txt) return missing('answerText')
    const hit = isCommandTone(txt)
    return hit ? fail('COMMAND_TONE_DETECTED', `面试官参考滑向命令式剧本：${hit.source}`) : pass('L2_reference_not_command', '保持参考而非指令定位')
  },

  L2_tied_to_rubric_gaps: (a) => {
    const offRubric = num(a.payload.offRubricSuggestions)
    if (offRubric === undefined) return missing('offRubricSuggestions')
    return offRubric > 0 ? fail('OFF_RUBRIC_SUGGESTION', `存在 ${offRubric} 条脱离岗标疑点的发散建议`) : pass('L2_tied_to_rubric_gaps', '本轮参考紧扣岗标疑点')
  },

  L2_only_uncovered_rubric_dims: (a) => {
    const uncovered = arrStr(a.payload.expectedUncoveredDims)
    const output = arrStr(a.payload.outputUncoveredDims)
    const extra = num(a.payload.outOfRubricExtraItems)
    if (!uncovered || !output || extra === undefined) return missing('expectedUncoveredDims + outputUncoveredDims + outOfRubricExtraItems')
    const missed = uncovered.filter((d) => !output.includes(d))
    if (missed.length > 0) return fail('UNCOVERED_DIM_MISSED', `漏报未覆盖岗标：${missed.join(', ')}`)
    if (extra > 0) return fail('OUT_OF_RUBRIC_ITEMS', `摘要混入 ${extra} 条岗标外杂项`)
    return pass('L2_only_uncovered_rubric_dims', '未覆盖岗标差集完整且无杂项')
  },

  L2_no_redundant_repeat_questions: (a) => {
    const covered = arrStr(a.payload.alreadyCoveredDims)
    const recommended = arrStr(a.payload.recommendedDims)
    if (!covered || !recommended) return missing('alreadyCoveredDims + recommendedDims')
    const coveredSet = new Set(covered)
    const repeated = recommended.filter((d) => coveredSet.has(d))
    return repeated.length > 0 ? fail('REDUNDANT_REPEAT_DIM', `重复推荐前轮已聊透维度：${repeated.join(', ')}`) : pass('L2_no_redundant_repeat_questions', '未重复建议前轮已充分验证维度')
  },

  L2_cross_round_anchor_isolated: (a) => {
    const txt = textOf(a)
    const leakedScore = bool(a.payload.priorScoreLeaked)
    if (!txt || leakedScore === undefined) return missing('answerText + priorScoreLeaked')
    const hit = isSubjectiveLeak(txt)
    if (leakedScore || hit) return fail('CROSS_ROUND_ANCHOR_LEAK', `跨轮简报透传了上轮主观情绪或分数${hit ? '：' + hit.source : ''}`)
    return pass('L2_cross_round_anchor_isolated', '跨轮锚定偏见已隔离')
  },

  L2_schedule_slot_recommendation_valid: (a) => {
    const conflict = bool(a.payload.slotHasConflict)
    if (conflict === undefined) return missing('slotHasConflict')
    return conflict ? fail('SCHEDULE_CONFLICT', '推荐的面试时段与满档面试官冲突') : pass('L2_schedule_slot_recommendation_valid', '排期建议无冲突')
  },

  L2_pin_constraint_propagated: (a) => {
    const propagated = bool(a.payload.pinConstraintVisible)
    if (propagated === undefined) return missing('pinConstraintVisible')
    return propagated ? pass('L2_pin_constraint_propagated', '置顶约束已透传至 S10 汇总') : fail('PIN_CONSTRAINT_DROPPED', '候选人置顶约束在汇总中丢失')
  },

  L2_silver_medalist_facts: (a) => {
    const fabricated = bool(a.payload.fabricatedHistoryFact)
    const includedApplied = bool(a.payload.includedAlreadyApplied)
    if (fabricated === undefined || includedApplied === undefined) return missing('fabricatedHistoryFact + includedAlreadyApplied')
    if (fabricated) return fail('FABRICATED_SILVER_FACT', '编造了历史条件')
    if (includedApplied) return fail('ALREADY_APPLIED_RECALLED', '违规召回了已投递当前岗位的候选人')
    return pass('L2_silver_medalist_facts', '银牌跨岗召回事实准确且排除已投递者')
  },

  L2_six_month_audit_complete: (a) => {
    const missingLinks = arrStr(a.payload.missingAuditNodes)
    const usedNewRubric = bool(a.payload.retroactivelyUsedNewRubric)
    if (!missingLinks || usedNewRubric === undefined) return missing('missingAuditNodes + retroactivelyUsedNewRubric')
    if (usedNewRubric) return fail('RETROACTIVE_NEW_RUBRIC', '复盘违规用新版岗标倒推旧决定')
    if (missingLinks.length > 0) return fail('AUDIT_CHAIN_BROKEN', `半年复盘缺失环节：${missingLinks.join(', ')}`)
    return pass('L2_six_month_audit_complete', '半年后追责时间线完整')
  },

  L2_incomplete_scorecard_flagged: (a) => {
    const flagged = bool(a.payload.missingScorecardFlagged)
    const zeroFilled = bool(a.payload.missingTreatedAsZero)
    if (flagged === undefined || zeroFilled === undefined) return missing('missingScorecardFlagged + missingTreatedAsZero')
    if (zeroFilled) return fail('MISSING_AS_ZERO', '缺面评被违规折算为 0 分或反对票')
    if (!flagged) return fail('MISSING_SCORECARD_UNFLAGGED', '未醒目标出尚未提交面评的轮次')
    return pass('L2_incomplete_scorecard_flagged', '缺面评轮次已醒目标出且未折算 0 分')
  },

  L2_conflict_neutral_both_sides_kept: (a) => {
    const sideAKept = bool(a.payload.sideAQuoteKept)
    const sideBKept = bool(a.payload.sideBQuoteKept)
    const tookSide = bool(a.payload.implicitSideTaken)
    if (sideAKept === undefined || sideBKept === undefined || tookSide === undefined) {
      return missing('sideAQuoteKept + sideBQuoteKept + implicitSideTaken')
    }
    const txt = textOf(a) ?? ''
    if (!sideAKept || !sideBKept) return fail('CONFLICT_SIDE_DROPPED', '冲突面评汇总遗漏了一方原话')
    if (tookSide || SIDE_TAKING_PATTERNS.some((re) => re.test(txt))) return fail('IMPLICIT_SIDE_TAKEN', '冲突面评汇总出现隐性站队')
    return pass('L2_conflict_neutral_both_sides_kept', '冲突面评保持中立并保留双方原话')
  },

  L2_context_binding_exact: (a) => {
    if (!a.trajectory?.expectedApplicationId) return missing('trajectory.expectedApplicationId')
    return gradeContextBinding(a.trajectory)
  },

  L2_propose_write_required: (a) => {
    if (!a.trajectory?.expectedWriteIntent) return missing('trajectory.expectedWriteIntent')
    return gradeWriteNeedsPropose(a.trajectory)
  },

  L2_read_before_answer: (a, lc) => {
    const traj = trajectoryOf(a, lc)
    if (!traj) return missing('trajectory')
    return gradeReadBeforeAnswer(traj)
  },

  L2_mid_process_jd_change_reconciled: (a) => {
    const oldPinnedIntact = bool(a.payload.oldRubricPinnedIntact)
    if (oldPinnedIntact === undefined) return missing('oldRubricPinnedIntact')
    return oldPinnedIntact ? pass('L2_mid_process_jd_change_reconciled', '中途改 JD 未篡改旧申请钉住的岗标版本') : fail('OLD_RUBRIC_MUTATED', '中途改 JD 静默覆盖了旧申请历史初筛事实')
  },

  L2_mid_process_transfer_context_intact: (a) => {
    const crossJobLeak = bool(a.payload.crossJobScorecardMixed)
    const historyIntact = bool(a.payload.personHistoryIntact)
    if (crossJobLeak === undefined || historyIntact === undefined) return missing('crossJobScorecardMixed + personHistoryIntact')
    if (crossJobLeak) return fail('CROSS_JOB_MIXED', '转岗后把 A 岗面评误算成了 B 岗结论')
    if (!historyIntact) return fail('TRANSFER_HISTORY_LOST', '转岗后候选人历史档案断链')
    return pass('L2_mid_process_transfer_context_intact', '转岗上下文完整且不串岗')
  },

  L2_handoff_integrity_100: (a) => {
    const broken = arrStr(a.payload.brokenHandoffs)
    if (!broken) return missing('brokenHandoffs[]')
    return broken.length > 0 ? fail('HANDOFF_BROKEN', `跨阶段交接断链：${broken.join(', ')}`) : pass('L2_handoff_integrity_100', '全周期跨阶段交接 100% 完整')
  },
}

export function registerV2L2Graders(registry: GraderRegistry): void {
  for (const [id, fn] of Object.entries(V2_L2_GRADERS)) {
    registry.register(id, fn)
  }
}
