// recruitment_ui_dispatch / propose_write 的严格 fail-closed 单测。
// 重点：5 类 intent 合法草稿 + 非法 UUID / 缺业务字段 / summary 越界 / 未知 intent 一律 INVALID_ARGS。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeUiAction,
  validateWriteProposal,
  type UiWriteIntent,
  type UiWriteProposal,
} from '../../src/tools/ui-dispatch.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const APP = '11111111-1111-4111-8111-000000000701'
const INTERVIEWER = '11111111-1111-4111-8111-000000000104'

const SUMMARY = [
  { label: '候选人', value: '演示候选人-张样例' },
  { label: '岗位', value: '后端工程师（演示）' },
]

function base(intent: UiWriteIntent, payload: Record<string, unknown>): UiWriteProposal {
  return {
    intent,
    application_id: APP,
    title: '确认执行',
    summary: SUMMARY,
    fallback_modal: intent === 'screening_decide' ? 'screening' : undefined,
    payload,
  } as UiWriteProposal
}

function expectInvalid(fn: () => unknown, message: string): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof RecruitmentToolError && error.code === 'INVALID_ARGS',
    message,
  )
}

test('5 类 intent 合法用例全部通过并保留业务字段', () => {
  const cases: Array<[UiWriteIntent, Record<string, unknown>, Record<string, unknown>]> = [
    ['screening_decide', { decision: 'PASS', rationale: '工作与教育经历符合标准' }, { decision: 'PASS', rationale: '工作与教育经历符合标准' }],
    ['stage_advance', { target_stage: 'S8' }, { target_stage: 'S8' }],
    ['candidate_constraint', { constraint_kind: 'PIN', constraint_text: '二面重点追问带团队细节' }, { constraint_kind: 'PIN', constraint_text: '二面重点追问带团队细节' }],
    ['interview_schedule', {
      interviewer_id: INTERVIEWER,
      scheduled_start: '2026-11-23T10:00:00+08:00',
      scheduled_end: '2026-11-23T11:00:00+08:00',
      round_number: 2,
      timezone: 'Asia/Shanghai',
    }, {
      interviewer_id: INTERVIEWER,
      scheduled_start: '2026-11-23T10:00:00+08:00',
      scheduled_end: '2026-11-23T11:00:00+08:00',
      round_number: 2,
      timezone: 'Asia/Shanghai',
    }],
    ['decision_record', { final_outcome: 'HIRE' }, { final_outcome: 'HIRE' }],
  ]
  for (const [intent, payload, expected] of cases) {
    const parsed = normalizeUiAction({ action: 'propose_write', label: '待确认', proposal: base(intent, payload) })
    assert.equal(parsed.action, 'propose_write')
    assert.equal(parsed.proposal?.intent, intent)
    assert.equal(parsed.proposal?.application_id, APP)
    assert.deepEqual(parsed.proposal?.summary, SUMMARY)
    assert.deepEqual(parsed.proposal?.payload, expected)
  }
})

test('非法 UUID / 未知 intent / 未知字段 fail-closed', () => {
  expectInvalid(() => normalizeUiAction({ action: 'propose_write' }), 'proposal 必填')
  expectInvalid(() => normalizeUiAction({ action: 'propose_write', proposal: base('screening_decide', { decision: 'PASS' }), route: 'talent' }), '不得混用 route')
  expectInvalid(() => normalizeUiAction({ action: 'suggest_action', modal: 'screening', label: '去初筛', proposal: base('screening_decide', { decision: 'PASS' }) }), '只有 propose_write 允许 proposal')
  expectInvalid(() => validateWriteProposal({ ...base('screening_decide', { decision: 'PASS' }), application_id: 'not-a-uuid' }), '非法 application UUID')
  expectInvalid(() => validateWriteProposal({ ...base('screening_decide', { decision: 'PASS' }), intent: 'unknown' }), '未知 intent')
  expectInvalid(() => validateWriteProposal({ ...base('screening_decide', { decision: 'PASS' }), extra: true }), 'proposal 未知字段')
  expectInvalid(() => validateWriteProposal(base('screening_decide', { decision: 'PASS', unexpected: 1 })), 'payload 未知字段')
})

test('title / summary 越界与机器码 fail-closed', () => {
  const ok = base('screening_decide', { decision: 'PASS' })
  expectInvalid(() => validateWriteProposal({ ...ok, title: '' }), '空 title')
  expectInvalid(() => validateWriteProposal({ ...ok, title: '一'.repeat(25) }), 'title >24')
  expectInvalid(() => validateWriteProposal({ ...ok, title: '11111111-1111-4111-8111-000000000701' }), 'title UUID')
  expectInvalid(() => validateWriteProposal({ ...ok, summary: [{ label: '候选人', value: '张三' }] }), 'summary <2')
  expectInvalid(() => validateWriteProposal({ ...ok, summary: Array.from({ length: 5 }, () => ({ label: '键', value: '值' })) }), 'summary >4')
  expectInvalid(() => validateWriteProposal({ ...ok, summary: [{ label: '一'.repeat(13), value: '值' }, { label: '键', value: '值' }] }), 'label >12')
  expectInvalid(() => validateWriteProposal({ ...ok, summary: [{ label: '键', value: '值'.repeat(49) }, { label: '键', value: '值' }] }), 'value >48')
  expectInvalid(() => validateWriteProposal({
    ...ok,
    summary: [{ label: '候选人', value: APP }, { label: '岗位', value: '后端' }],
  }), 'summary UUID')
  expectInvalid(() => validateWriteProposal({ ...ok, summary: [{ label: '候选人', value: 'PASS' }, { label: '岗位', value: '后端' }] }), 'summary 机器码')
  expectInvalid(() => validateWriteProposal({ ...ok, tone: 'warning' }), 'tone 非法')
  expectInvalid(() => validateWriteProposal({ ...ok, fallback_modal: 'unknown' }), 'fallback_modal 非法')
})

test('各 intent 缺业务字段 / 枚举错误 fail-closed', () => {
  expectInvalid(() => validateWriteProposal(base('screening_decide', {})), '缺 decision')
  expectInvalid(() => validateWriteProposal(base('screening_decide', { decision: 'MAYBE' })), 'decision 非法')
  expectInvalid(() => validateWriteProposal(base('stage_advance', {})), '缺 target_stage')
  expectInvalid(() => validateWriteProposal(base('stage_advance', { target_stage: ' ' })), '空 target_stage')
  expectInvalid(() => validateWriteProposal(base('candidate_constraint', { constraint_kind: 'PIN' })), '缺 constraint_text')
  expectInvalid(() => validateWriteProposal(base('candidate_constraint', { constraint_kind: 'OTHER', constraint_text: '内容' })), 'constraint_kind 非法')
  expectInvalid(() => validateWriteProposal(base('decision_record', {})), '缺 final_outcome')
  expectInvalid(() => validateWriteProposal(base('decision_record', { final_outcome: 'MAYBE' })), 'final_outcome 非法')
  expectInvalid(() => validateWriteProposal(base('interview_schedule', { interviewer_id: INTERVIEWER })), '缺时间')
  expectInvalid(() => validateWriteProposal(base('interview_schedule', {
    interviewer_id: 'not-a-uuid',
    scheduled_start: '2026-11-23T10:00:00+08:00',
    scheduled_end: '2026-11-23T11:00:00+08:00',
  })), 'interviewer 非 UUID')
  expectInvalid(() => validateWriteProposal(base('interview_schedule', {
    interviewer_id: INTERVIEWER,
    scheduled_start: '2026-11-23T10:00:00',
    scheduled_end: '2026-11-23T11:00:00',
  })), '时间缺时区偏移')
  expectInvalid(() => validateWriteProposal(base('interview_schedule', {
    interviewer_id: INTERVIEWER,
    scheduled_start: '2026-11-23T11:00:00+08:00',
    scheduled_end: '2026-11-23T10:00:00+08:00',
  })), '结束早于开始')
  expectInvalid(() => validateWriteProposal(base('interview_schedule', {
    interviewer_id: INTERVIEWER,
    scheduled_start: '2026-11-23T10:00:00+08:00',
    scheduled_end: '2026-11-23T11:00:00+08:00',
    timezone: 'Not/AZone',
  })), '非法 IANA 时区')
})
