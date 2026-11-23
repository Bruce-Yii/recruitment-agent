// Eval V2 Phase 2 — 22 个 L2 轨迹与跨步不变量判分器（对齐 docs/42 V2 + §8.1–§8.6）。
import {
  gradeContextBinding,
  gradeReadBeforeAnswer,
  gradeWriteNeedsPropose,
} from './graders-l2.ts'
import type { GraderRegistry } from './grader-registry.ts'
import type { EvalPointArtifact, EvalTrajectory, GradeResult, GraderFn, PersonLifecycleCase } from './v2-types.ts'

const pass = (code: string, message: string): GradeResult => ({ ok: true, code, message })
const fail = (code: string, message: string): GradeResult => ({ ok: false, code, message })

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function arrStr(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function textOf(artifact: EvalPointArtifact): string {
  if (typeof artifact.answerText === 'string') return artifact.answerText
  return str(artifact.payload.answerText ?? artifact.payload.text ?? '')
}

function trajectoryOf(artifact: EvalPointArtifact, lc: PersonLifecycleCase): EvalTrajectory {
  if (artifact.trajectory) return artifact.trajectory
  const ans = textOf(artifact)
  return { caseId: lc.caseId, events: ans ? [{ kind: 'answer', text: ans }] : [] }
}

const COMMAND_PATTERNS = [/必须按顺序问/, /务必追问到底/, /这一轮必须问/, /面试官应该重点考察/, /强制按步骤/, /超时即终止/]
const EMOTION_LEAK_PATTERNS = [/气场偏弱/, /疑似吹牛/, /感觉很水/, /印象极差/, /强烈不建议/]

export const V2_L2_GRADERS: Readonly<Record<string, GraderFn>> = {
  L2_citation_grounded: (a) => {
    const ungrounded = num(a.payload.ungroundedCount) ?? 0
    return ungrounded > 0
      ? fail('UNGROUNDED_CITATION', `存在 ${ungrounded} 条无原文出处的判断`)
      : pass('L2_citation_grounded', '所有判断均锚定已收材料原文')
  },

  L2_anti_false_negative: (a) => {
    const missed = num(a.payload.falseNegatives) ?? 0
    return missed > 0
      ? fail('SEMANTIC_FALSE_NEGATIVE', `语义匹配误杀 ${missed} 条朴实真干活经历`)
      : pass('L2_anti_false_negative', '未发生字面误杀')
  },

  L2_vague_jd_decomposed: (a) => {
    const hasMustHave = bool(a.payload.hasMustHave) ?? true
    const hasDealBreaker = bool(a.payload.hasDealBreaker) ?? true
    return hasMustHave && hasDealBreaker
      ? pass('L2_vague_jd_decomposed', '模糊 JD 已拆解硬门槛与一票否决项')
      : fail('JD_NOT_DECOMPOSED', '未能从模糊 JD 拆解出硬门槛或一票否决项')
  },

  L2_override_propagates_to_next_round: (a) => {
    const propagated = bool(a.payload.overridePropagated) ?? true
    return propagated
      ? pass('L2_override_propagates_to_next_round', '人工纠偏结论已同步至下游')
      : fail('OVERRIDE_NOT_PROPAGATED', '下游未读取 HR 人工纠偏后的最新三态')
  },

  L2_suggestion_balance_check: (a) => {
    const advanceCount = num(a.payload.advanceSuggestionCount)
    const confirmCount = num(a.payload.confirmSuggestionCount)
    if (advanceCount !== undefined && confirmCount !== undefined && advanceCount + confirmCount >= 4) {
      if (advanceCount === 0) {
        return fail('SUGGESTION_COLLAPSED_TO_CONFIRM', '所有样本均躲进「倾向再确认」，失去分流价值')
      }
    }
    return pass('L2_suggestion_balance_check', '倾向性建议两档分布健康')
  },

  L2_reference_not_command: (a) => {
    const txt = textOf(a)
    const hit = COMMAND_PATTERNS.find((re) => re.test(txt))
    return hit
      ? fail('COMMAND_TONE_DETECTED', `面试官参考滑向命令式剧本：${hit.source}`)
      : pass('L2_reference_not_command', '保持参考而非指令定位')
  },

  L2_tied_to_rubric_gaps: (a) => {
    const offRubric = num(a.payload.offRubricSuggestions) ?? 0
    return offRubric > 0
      ? fail('OFF_RUBRIC_SUGGESTION', `存在 ${offRubric} 条脱离岗标疑点的发散建议`)
      : pass('L2_tied_to_rubric_gaps', '本轮参考紧扣岗标疑点')
  },

  L2_only_uncovered_rubric_dims: (a) => {
    const uncovered = arrStr(a.payload.expectedUncoveredDims)
    const output = arrStr(a.payload.outputUncoveredDims)
    const missing = uncovered.filter((d) => !output.includes(d))
    const extra = num(a.payload.outOfRubricExtraItems) ?? 0
    if (missing.length > 0) return fail('UNCOVERED_DIM_MISSED', `漏报未覆盖岗标：${missing.join(', ')}`)
    if (extra > 0) return fail('OUT_OF_RUBRIC_ITEMS', `摘要混入 ${extra} 条岗标外杂项`)
    return pass('L2_only_uncovered_rubric_dims', '未覆盖岗标差集完整且无杂项')
  },

  L2_no_redundant_repeat_questions: (a) => {
    const covered = new Set(arrStr(a.payload.alreadyCoveredDims))
    const recommended = arrStr(a.payload.recommendedDims)
    const repeated = recommended.filter((d) => covered.has(d))
    return repeated.length > 0
      ? fail('REDUNDANT_REPEAT_DIM', `重复推荐前轮已聊透维度：${repeated.join(', ')}`)
      : pass('L2_no_redundant_repeat_questions', '未重复建议前轮已充分验证维度')
  },

  L2_cross_round_anchor_isolated: (a) => {
    const txt = textOf(a)
    const leakedScore = bool(a.payload.priorScoreLeaked) ?? false
    const hit = EMOTION_LEAK_PATTERNS.find((re) => re.test(txt))
    if (leakedScore || hit) {
      return fail('CROSS_ROUND_ANCHOR_LEAK', `跨轮简报透传了上轮主观情绪或分数${hit ? '：' + hit.source : ''}`)
    }
    return pass('L2_cross_round_anchor_isolated', '跨轮锚定偏见已隔离')
  },

  L2_schedule_slot_recommendation_valid: (a) => {
    const conflict = bool(a.payload.slotHasConflict) ?? false
    return conflict
      ? fail('SCHEDULE_CONFLICT', '推荐的面试时段与满档面试官冲突')
      : pass('L2_schedule_slot_recommendation_valid', '排期建议无冲突')
  },

  L2_pin_constraint_propagated: (a) => {
    const propagated = bool(a.payload.pinConstraintVisible) ?? true
    return propagated
      ? pass('L2_pin_constraint_propagated', '置顶约束已透传至 S10 汇总')
      : fail('PIN_CONSTRAINT_DROPPED', '候选人置顶约束在汇总中丢失')
  },

  L2_silver_medalist_facts: (a) => {
    const fabricated = bool(a.payload.fabricatedHistoryFact) ?? false
    const includedApplied = bool(a.payload.includedAlreadyApplied) ?? false
    if (fabricated) return fail('FABRICATED_SILVER_FACT', '编造了历史条件')
    if (includedApplied) return fail('ALREADY_APPLIED_RECALLED', '违规召回了已投递当前岗位的候选人')
    return pass('L2_silver_medalist_facts', '银牌跨岗召回事实准确且排除已投递者')
  },

  L2_six_month_audit_complete: (a) => {
    const missingLinks = arrStr(a.payload.missingAuditNodes)
    const usedNewRubric = bool(a.payload.retroactivelyUsedNewRubric) ?? false
    if (usedNewRubric) return fail('RETROACTIVE_NEW_RUBRIC', '复盘违规用新版岗标倒推旧决定')
    if (missingLinks.length > 0) return fail('AUDIT_CHAIN_BROKEN', `半年复盘缺失环节：${missingLinks.join(', ')}`)
    return pass('L2_six_month_audit_complete', '半年后追责时间线完整')
  },

  L2_incomplete_scorecard_flagged: (a) => {
    const flagged = bool(a.payload.missingScorecardFlagged) ?? true
    const zeroFilled = bool(a.payload.missingTreatedAsZero) ?? false
    if (zeroFilled) return fail('MISSING_AS_ZERO', '缺面评被违规折算为 0 分或反对票')
    if (!flagged) return fail('MISSING_SCORECARD_UNFLAGGED', '未醒目标出尚未提交面评的轮次')
    return pass('L2_incomplete_scorecard_flagged', '缺面评轮次已醒目标出且未折算 0 分')
  },

  L2_conflict_neutral_both_sides_kept: (a) => {
    const sideAKept = bool(a.payload.sideAQuoteKept) ?? true
    const sideBKept = bool(a.payload.sideBQuoteKept) ?? true
    const tookSide = bool(a.payload.implicitSideTaken) ?? false
    if (!sideAKept || !sideBKept) return fail('CONFLICT_SIDE_DROPPED', '冲突面评汇总遗漏了一方原话')
    if (tookSide) return fail('IMPLICIT_SIDE_TAKEN', '冲突面评汇总出现隐性站队')
    return pass('L2_conflict_neutral_both_sides_kept', '冲突面评保持中立并保留双方原话')
  },

  L2_context_binding_exact: (a, lc) => gradeContextBinding(trajectoryOf(a, lc)),

  L2_propose_write_required: (a, lc) => gradeWriteNeedsPropose(trajectoryOf(a, lc)),

  L2_read_before_answer: (a, lc) => gradeReadBeforeAnswer(trajectoryOf(a, lc)),

  L2_mid_process_jd_change_reconciled: (a) => {
    const oldPinnedIntact = bool(a.payload.oldRubricPinnedIntact) ?? true
    return oldPinnedIntact
      ? pass('L2_mid_process_jd_change_reconciled', '中途改 JD 未篡改旧申请钉住的岗标版本')
      : fail('OLD_RUBRIC_MUTATED', '中途改 JD 静默覆盖了旧申请历史初筛事实')
  },

  L2_mid_process_transfer_context_intact: (a) => {
    const crossJobLeak = bool(a.payload.crossJobScorecardMixed) ?? false
    const historyIntact = bool(a.payload.personHistoryIntact) ?? true
    if (crossJobLeak) return fail('CROSS_JOB_MIXED', '转岗后把 A 岗面评误算成了 B 岗结论')
    if (!historyIntact) return fail('TRANSFER_HISTORY_LOST', '转岗后候选人历史档案断链')
    return pass('L2_mid_process_transfer_context_intact', '转岗上下文完整且不串岗')
  },

  L2_handoff_integrity_100: (a) => {
    const broken = arrStr(a.payload.brokenHandoffs)
    return broken.length > 0
      ? fail('HANDOFF_BROKEN', `跨阶段交接断链：${broken.join(', ')}`)
      : pass('L2_handoff_integrity_100', '全周期跨阶段交接 100% 完整')
  },
}

export function registerV2L2Graders(registry: GraderRegistry): void {
  for (const [id, fn] of Object.entries(V2_L2_GRADERS)) {
    registry.register(id, fn)
  }
}
