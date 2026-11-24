// Eval V2 — P6-08 / P6-09 跨阶段全周期漏斗轨迹适配器单测（正例 + fail-closed 反例）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  adaptFunnelTrajectoryToP6Artifact,
  REQUIRED_SIX_MONTH_AUDIT_NODES,
  type FunnelStageSnapshot,
} from './v2-funnel-driver.ts'
import { V2_L1_GRADERS } from './v2-graders-l1.ts'
import { V2_L2_GRADERS } from './v2-graders-l2.ts'

const COMPLETE_HIRE_SNAP: FunnelStageSnapshot = {
  candidateId: 'cand-101',
  jobId: 'job-202',
  p1: { documentSha256: 'a'.repeat(64), candidateId: 'cand-101' },
  p2: { candidateId: 'cand-101', jobId: 'job-202', rubricVersion: 'rubric-v1' },
  p3: { candidateId: 'cand-101', jobId: 'job-202', briefGenerated: true },
  p4: { candidateId: 'cand-101', transcriptVerified: true, treatedAsFinalWithoutVerify: false },
  p5: { candidateId: 'cand-101', humanConfirmed: true, outcome: 'hire' },
  audit: {
    presentNodes: [...REQUIRED_SIX_MONTH_AUDIT_NODES],
    originalRubricVersion: 'rubric-v1',
    reviewRubricVersion: 'rubric-v1',
  },
}

describe('Eval V2 P6-08 / P6-09 跨阶段全周期漏斗轨迹驱动', () => {
  test('P6-08 顺利录用全周期档案贯通：L1_person_lifecycle_zero_violation 与 L2_handoff_integrity_100 双过', () => {
    const art = adaptFunnelTrajectoryToP6Artifact('P6-08', COMPLETE_HIRE_SNAP)
    assert.equal(V2_L1_GRADERS.L1_person_lifecycle_zero_violation(art).ok, true)
    assert.equal(V2_L2_GRADERS.L2_handoff_integrity_100(art).ok, true)
  })

  test('P6-08 跨阶段断链或跳过人工确认（fail-closed）：两项判据精准拦截', () => {
    const broken = adaptFunnelTrajectoryToP6Artifact('P6-08', {
      ...COMPLETE_HIRE_SNAP,
      p3: { candidateId: 'cand-WRONG', jobId: 'job-202', briefGenerated: false },
      p5: { candidateId: 'cand-101', humanConfirmed: false, outcome: 'hire' },
    })
    assert.equal(V2_L1_GRADERS.L1_person_lifecycle_zero_violation(broken).ok, false)
    assert.equal(V2_L2_GRADERS.L2_handoff_integrity_100(broken).ok, false)
  })

  test('P6-09 纠偏+淘汰半年复盘全链完整：L1_person_lifecycle_zero_violation 与 L2_six_month_audit_complete 双过', () => {
    const art = adaptFunnelTrajectoryToP6Artifact('P6-09', {
      ...COMPLETE_HIRE_SNAP,
      p2: { candidateId: 'cand-101', jobId: 'job-202', rubricVersion: 'rubric-v1', overrideRecorded: true },
      p5: { candidateId: 'cand-101', humanConfirmed: true, outcome: 'reject' },
    })
    assert.equal(V2_L1_GRADERS.L1_person_lifecycle_zero_violation(art).ok, true)
    assert.equal(V2_L2_GRADERS.L2_six_month_audit_complete(art).ok, true)
  })

  test('P6-09 复盘违规用新版岗标倒推旧决定或缺失审计节点（fail-closed）：精准拦截', () => {
    const retro = adaptFunnelTrajectoryToP6Artifact('P6-09', {
      ...COMPLETE_HIRE_SNAP,
      audit: {
        presentNodes: ['screening_override', 'round1_brief'],
        originalRubricVersion: 'rubric-v1',
        reviewRubricVersion: 'rubric-v2',
      },
    })
    const res = V2_L2_GRADERS.L2_six_month_audit_complete(retro)
    assert.equal(res.ok, false)
    assert.equal(res.code, 'RETROACTIVE_NEW_RUBRIC')
  })
})
