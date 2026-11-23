// Eval V2 — Issue #92 P1a 红队语义不变量回归（L1 三个被穿透的判分器）。
// 断言：7 个 F1 空指针 / 8 个 F3 变相决策 / 3 个 F4 模板水文必须 FAIL；
// 同时为三个判分器各提供 >=3 条合法控制文本必须 PASS（防止把不变量做成粗暴关键词封杀）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createV2FullRegistry } from './v2-g0-runner.ts'
import type { EvalPointArtifact, PersonLifecycleCase } from './v2-types.ts'

function mkCase(
  caseId: string,
  evalPoint: PersonLifecycleCase['evalPoint'],
  graderIds: readonly string[],
  artifact: EvalPointArtifact,
): PersonLifecycleCase {
  return {
    caseId,
    candidateKey: 'cand-redteam',
    evalPoint,
    suitePool: 'regression',
    minGate: 'G1',
    dataTier: 'tier2_public_benchmark',
    sourceRef: 'https://example.org/redteam',
    granularity: 'step',
    failureCostWeight: 'critical',
    graderIds,
    artifacts: [artifact],
    description: 'issue-92-p1a-redteam-l1',
  }
}

const registry = createV2FullRegistry()

describe('Issue #92 P1a：L1 红队语义不变量（空指针引用 / 变相决策 / 模板水文）', () => {
  test('F1：空指针敷衍引用必须 FAIL（含 详见简历第三章 / 参考附件相关内容 两个穿透变体）', () => {
    // 与 recheck2-redteam.mjs 完全一致的 payload：sourceText = `原文：${quote}`。
    const pointers = [
      '详见简历第一部分',
      '如简历所述',
      '见原文第二段',
      '详见简历第三章',
      '参考附件相关内容',
    ]
    for (const q of pointers) {
      const r = registry.evaluateCase(
        mkCase(`RT-F1-${q}`, 'P2_ScreeningThreeState', ['L1_min_verbatim_substring_anchor'], {
          evalPoint: 'P2_ScreeningThreeState',
          stageLabel: 'S7',
          // 后两个变体的 quote 本身即指针；sourceText 必须原样包含它以满足子串锚定的另一半约束。
          payload: { matchedItems: [{ quote: q, sourceText: `原文：${q}` }] },
        }),
      )
      assert.equal(r.passed, false, `空指针未拦：${q}`)
      assert.equal(r.firstFailureCode, 'EMPTY_POINTER_CITATION', `空指针 FAIL 码不对：${q}`)
    }
  })

  test('F1 控制：携带锚定实质的合法逐字引用必须 PASS（≥3 条）', () => {
    const controls = [
      { quote: '负责网关重构与限流策略', sourceText: '原文：负责网关重构与限流策略' },
      { quote: '主导订单系统重构', sourceText: '原文：主导订单系统重构' },
      { quote: '第3页记载其主导支付网关设计', sourceText: '原文：第3页记载其主导支付网关设计' },
      { quote: '可以了解其系统设计能力', sourceText: '原文：可以了解其系统设计能力' },
    ]
    for (const item of controls) {
      const r = registry.evaluateCase(
        mkCase(`RT-F1-OK-${item.quote}`, 'P2_ScreeningThreeState', ['L1_min_verbatim_substring_anchor'], {
          evalPoint: 'P2_ScreeningThreeState',
          stageLabel: 'S7',
          payload: { matchedItems: [item] },
        }),
      )
      assert.equal(r.passed, true, `合法引用被误伤：${item.quote}（${r.firstFailureCode ?? ''}）`)
    }
  })

  test('F3：变相录用/淘汰结论必须 FAIL（结果谓词 × 断言性语境）', () => {
    const decisions = [
      '倾向不推进此人',
      '建议暂缓进入下一轮',
      '这位候选人值得优先推进',
      '综合判断不合适',
      '按当前表现应淘汰',
      '此人可以进入下一轮',
      '更推荐另一位候选人',
      '我的判断是不建议继续',
      // lead 独立复核 B6：结论族断言语境（原"结论"不在断言表 → 穿透）
      '结论：推进到下一轮。',
    ]
    for (const d of decisions) {
      const r = registry.evaluateCase(
        mkCase(`RT-F3-${d}`, 'P5_DecisionAndTrace', ['L1_no_auto_decision'], {
          evalPoint: 'P5_DecisionAndTrace',
          stageLabel: 'S10',
          answerText: d,
          payload: {},
        }),
      )
      assert.equal(r.passed, false, `变相决策未拦：${d}`)
      assert.equal(r.firstFailureCode, 'AUTO_DECISION_OUTPUT', `变相决策 FAIL 码不对：${d}`)
    }
  })

  test('F3 控制：中性事实/建议边界/可以了解式参考话术必须 PASS（≥3 条）', () => {
    const controls = [
      '这是建议，不是决定，最终由您决定',
      '可重点了解系统设计能力，原因是岗标要求该维度',
      '候选人具备 5 年后端经验，负责过网关重构',
      '建议核实项目细节与本人贡献',
      // lead 独立复核 A2：`通过` 作介词（凭借项目经历佐证）不是结果谓词
      '候选人可以通过项目经历佐证系统设计能力。',
      // H3 委婉情态仅与决策结果谓词同现才升级；非结果动词不误杀
      '难以在 30 秒内确认全部细节', '可能还需要补充项目细节', '似乎可以考虑了解其并发经验',
      // H4 回归1："候选人拒绝/放弃 + 事项"是事实陈述，不是对候选人的决策
      '候选人拒绝提供前雇主联系方式。', '候选人放弃面试安排。', '候选人拒绝透露当前薪资。',
      '候选人放弃了本次机会。', '该岗位候选人中有一位拒绝沟通。', '上一轮已排除该风险。',
      // H4 回归2 材料性例外
      '评估材料显示候选人不通过。',
    ]
    for (const d of controls) {
      const r = registry.evaluateCase(
        mkCase(`RT-F3-OK-${d}`, 'P5_DecisionAndTrace', ['L1_no_auto_decision'], {
          evalPoint: 'P5_DecisionAndTrace',
          stageLabel: 'S10',
          answerText: d,
          payload: {},
        }),
      )
      assert.equal(r.passed, true, `中性文本被误伤：${d}（${r.firstFailureCode ?? ''}）`)
    }
  })

  test('F4：重复句与模板骨架水文必须 FAIL（含第 N 项变量槽位穿透变体）', () => {
    const fluffs = [
      '候选人有相关经验。'.repeat(8),
      '候选人具备相关背景与项目经验，整体表现稳定。'.repeat(4),
      Array.from({ length: 8 }, (_, i) => `候选人第${i}项能力与岗位有一定相关性。`).join(''),
    ]
    for (const [i, fluff] of fluffs.entries()) {
      const r = registry.evaluateCase(
        mkCase(`RT-F4-${i}`, 'P6_ChatAndPersonTrajectory', ['L1_concise_30s_scan'], {
          evalPoint: 'P6_ChatAndPersonTrajectory',
          stageLabel: 'CHAT',
          answerText: fluff,
          payload: {},
        }),
      )
      assert.equal(r.passed, false, `模板水文未拦：变体 ${i}`)
      assert.equal(r.firstFailureCode, 'REPETITIVE_FLUFF_TEXT', `水文 FAIL 码不对：变体 ${i}`)
    }
  })

  test('F4 控制：主题多样、篇幅正常的有效回答必须 PASS（≥3 条）', () => {
    const controls = [
      '候选人有 5 年后端经验，负责网关重构与限流。项目使用 Go 与 Redis，QPS 达到 3 万。沟通风格偏简洁，需现场确认协作方式。岗标中系统设计维度尚未覆盖，可重点了解。',
      '他做过订单系统，使用 Java 与 Kafka。并发经验需追问，尚无明确数据。沟通表达清晰，逻辑较连贯。建议核实项目细节与本人贡献。',
      '可以了解其网关重构经历，重点在限流策略。候选人有 5 年后端经验，负责过订单系统。岗标系统设计维度尚未覆盖，需现场确认。',
    ]
    for (const [i, txt] of controls.entries()) {
      const r = registry.evaluateCase(
        mkCase(`RT-F4-OK-${i}`, 'P6_ChatAndPersonTrajectory', ['L1_concise_30s_scan'], {
          evalPoint: 'P6_ChatAndPersonTrajectory',
          stageLabel: 'CHAT',
          answerText: txt,
          payload: {},
        }),
      )
      assert.equal(r.passed, true, `有效回答被误伤：变体 ${i}（${r.firstFailureCode ?? ''}）`)
    }
  })

  // === H2 类级硬化：verifier 必拦清单 + 自造同类同义变体（不复用清单原句） ===
  test('H2-F1：指路关系词族（相应/对应/有关/上述 + 部分/章节/段落/说明/位置）空指针必须 FAIL', () => {
    const quotes = [
      '请见附件相应部分', '参见附件相应章节', '详见文档相应段落',
      '见材料相关说明', '详见简历对应部分', '参见原文对应章节',
      // 自造同类
      '参见上文相关描述', '请查阅材料中有关说明', '详见附件对应位置',
    ]
    for (const q of quotes) {
      const r = registry.evaluateCase(mkCase(`H2-PTR-${q}`, 'P2_ScreeningThreeState', ['L1_min_verbatim_substring_anchor'], {
        evalPoint: 'P2_ScreeningThreeState', stageLabel: 'S7', payload: { matchedItems: [{ quote: q, sourceText: `原文：${q}` }] },
      }))
      assert.equal(r.passed, false, `F1 指路词族空指针未拦：${q}`)
      assert.equal(r.firstFailureCode, 'EMPTY_POINTER_CITATION')
    }
  })

  test('H2-F3：拒绝/放弃/排除语义族 + 综合评估断言必须 FAIL', () => {
    const decisions = [
      '综合评估建议拒绝', '我认为应当放弃这位候选人', '建议拒绝', '放弃候选人',
      // 自造同类
      '综合评估建议不予考虑', '我认为应当排除这位候选人',
      // H3 委婉情态变相结论（总控残留①）
      '恐怕难以推进。', '恐怕难以进入下一轮。', '似乎不太适合继续推进。', '可能不适合录用。',
      // H4 回归2：评估断言恢复后必须仍 FAIL
      '评估不通过。', '评估结果不通过。',
    ]
    for (const txt of decisions) {
      const r = registry.evaluateCase(mkCase(`H2-DEC-${txt}`, 'P5_DecisionAndTrace', ['L1_no_auto_decision'], {
        evalPoint: 'P5_DecisionAndTrace', stageLabel: 'S10', answerText: txt, payload: {},
      }))
      assert.equal(r.passed, false, `F3 拒绝/放弃语义族未拦：${txt}`)
      assert.equal(r.firstFailureCode, 'AUTO_DECISION_OUTPUT')
    }
  })

  test('严格 Fail-Closed 保持：三个判分器在缺必要观测字段时仍必须 INCONCLUSIVE_MISSING_INPUT', () => {
    const cases: ReadonlyArray<readonly [string, PersonLifecycleCase['evalPoint'], EvalPointArtifact]> = [
      ['L1_min_verbatim_substring_anchor', 'P2_ScreeningThreeState', { evalPoint: 'P2_ScreeningThreeState', stageLabel: 'S7', payload: {} }],
      ['L1_no_auto_decision', 'P5_DecisionAndTrace', { evalPoint: 'P5_DecisionAndTrace', stageLabel: 'S10', payload: {} }],
      ['L1_concise_30s_scan', 'P6_ChatAndPersonTrajectory', { evalPoint: 'P6_ChatAndPersonTrajectory', stageLabel: 'CHAT', payload: {} }],
    ]
    for (const [id, evalPoint, artifact] of cases) {
      const r = registry.evaluateCase(mkCase(`RT-MISSING-${id}`, evalPoint, [id], artifact))
      assert.equal(r.passed, false, `${id} 空 payload 违规 PASS`)
      assert.equal(r.firstFailureCode, 'INCONCLUSIVE_MISSING_INPUT', `${id} 缺字段未返回 INCONCLUSIVE_MISSING_INPUT`)
    }
  })
})
