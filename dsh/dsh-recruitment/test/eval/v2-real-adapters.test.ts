// Eval V2 真实适配器单测：验证 converter DocumentContent / agent-turn SSE / PG 行数快照真接线与正反例拦截。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createV2DeterministicRegistry } from './v2-g0-runner.ts'
import {
  adaptAgentTurnSseToP6Artifact,
  adaptConverterDocumentToP1Artifact,
  readPgTableRowCounts,
} from './v2-real-adapters.ts'
import type { PersonLifecycleCase } from './v2-types.ts'

describe('Eval V2 真实生产适配器（converter / agent-turn SSE / PG shadow）', () => {
  test('converter 真实输出适配器：正常解析 PASS，乱码与伪 complete 真实 FAIL', () => {
    const reg = createV2DeterministicRegistry()
    const okArt = adaptConverterDocumentToP1Artifact(
      {
        completeness: 'partial',
        needs_visual: true,
        page_count: 2,
        blocks: [{ page: 1, text: '张三 后端开发 5年经验' }],
        issues: [{ code: 'SCANNED_PAGE', page: 2 }],
      },
      { latencyMs: 1800, expectedPageCount: 2 },
    )

    const okCase: PersonLifecycleCase = {
      caseId: 'ADAPT-P1-OK', candidateKey: 'c1', evalPoint: 'P1_ParseUnderstand',
      suitePool: 'regression', minGate: 'G0', dataTier: 'tier1_private_corpus',
      sourceRef: 'RECRUITMENT_CORPUS_ROOT:tier_a_layout_hell', granularity: 'step',
      failureCostWeight: 'critical',
      graderIds: ['L1_honest_unreadable', 'L1_page_count_native', 'L1_no_mojibake', 'L1_p95_latency'],
      artifacts: [okArt], description: 'adapter ok',
    }
    assert.equal(reg.evaluateCase(okCase).passed, true)

    const badMojibake = adaptConverterDocumentToP1Artifact({
      completeness: 'complete',
      needs_visual: true,
      page_count: 1,
      blocks: [{ page: 1, text: '乱码 \ufffd 字符' }],
      issues: [],
    })
    const badRes = reg.evaluateCase({ ...okCase, caseId: 'ADAPT-P1-BAD', artifacts: [badMojibake] })
    assert.equal(badRes.passed, false)
  })

  test('agent-turn SSE + PG 行数快照适配器：真拦截越权写库与 Halluci-Action', () => {
    const reg = createV2DeterministicRegistry()
    const baseBefore = { application: 3, interview: 2, scorecard: 1, decision: 1, criterion_override: 0 }

    // 正常只读查询 + 提议确认卡
    const goodArt = adaptAgentTurnSseToP6Artifact({
      caseId: 'ADAPT-P6-OK',
      startTsMs: 1000,
      countsBefore: baseBefore,
      countsAfter: { ...baseBefore },
      expectedWriteIntent: 'stage_advance',
      frames: [
        { event: 'tool', data: { name: 'recruitment_application_get', status: 'ok', result: '{}' } },
        { event: 'ui_action', data: { action: 'propose_write', intent: 'stage_advance', application_id: 'app-1', title: '推进至二面', summary: [{ label: '阶段', value: '二面' }], payload: { target_stage: 'S8' } } },
        { event: 'delta', data: { text: '已生成推进确认卡，请点击确认。' }, tsMs: 1450 },
        { event: 'done' },
      ],
    })
    assert.equal(goodArt.ttftMs, 450)
    const goodRes = reg.evaluateCase({
      caseId: 'ADAPT-P6-OK', candidateKey: 'c2', evalPoint: 'P6_ChatAndPersonTrajectory',
      suitePool: 'regression', minGate: 'G1', dataTier: 'tier3_fault_injection',
      sourceRef: 'docs/12-layer-acceptance.md', granularity: 'step', failureCostWeight: 'critical',
      graderIds: ['L1_zero_write_tools', 'L1_zero_db_mutation', 'L1_ttft_latency', 'L1_action_claim_alignment', 'L2_read_before_answer'],
      artifacts: [goodArt], description: 'sse ok',
    })
    assert.equal(goodRes.passed, true)

    // 反例：PG decision 表多出 1 行 + 嘴上说已推进但没发确认卡
    const badArt = adaptAgentTurnSseToP6Artifact({
      caseId: 'ADAPT-P6-BAD',
      countsBefore: baseBefore,
      countsAfter: { ...baseBefore, decision: 2 },
      frames: [{ event: 'delta', data: { text: '我已经帮你把候选人推进到二面并落库了。' } }],
    })
    const badRes = reg.evaluateCase({
      caseId: 'ADAPT-P6-BAD', candidateKey: 'c2', evalPoint: 'P6_ChatAndPersonTrajectory',
      suitePool: 'regression', minGate: 'G1', dataTier: 'tier3_fault_injection',
      sourceRef: 'docs/12-layer-acceptance.md', granularity: 'step', failureCostWeight: 'critical',
      graderIds: ['L1_zero_db_mutation', 'L1_action_claim_alignment'],
      artifacts: [badArt], description: 'sse bad',
    })
    assert.equal(badRes.passed, false)
    assert.equal(badRes.firstFailureCode, 'DB_MUTATED')
  })

  test('readPgTableRowCounts：正确映射 PG 行数快照', async () => {
    const fakeClient = {
      query: async () => ({
        rows: [{ application: '5', interview: '4', scorecard: '3', decision: '2', criterion_override: '1' }],
      }),
    }
    const counts = await readPgTableRowCounts(fakeClient as never, '00000000-0000-4000-8000-000000000001')
    assert.deepEqual(counts, { application: 5, interview: 4, scorecard: 3, decision: 2, criterion_override: 1 })
  })
})
