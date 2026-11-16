// 产品复核 O18 的单测：工作台申请行的面试摘要必须**按轮**说明状态。
//
// 病根（真库 ra_fix_rem 事实，application 11111111-1111-4111-8111-000000000701）：
//   round 1 → POST_INTERVIEW（已面完）、round 2 → SCHEDULED（已排期），
//   旧 `interviewSummaryOf` 只取最后一轮的 `statusLabel`，得到 `2 轮 · 已排期`，
//   HR 看不出第 1 轮已经面完了。
//
// 口径（O18）：
//   * 0 轮 → `未排期`（tone gray）；
//   * 1 轮 → **保持原状** `1 轮 · <statusLabel>`（单轮不存在"被某一轮状态覆盖"的歧义，
//     不扩大改动面；仍用全局状态机口径，例如 POST_INTERVIEW → `面试后`）；
//   * ≥2 轮 → `N 轮 · 第 i 轮<摘要专用标签> / 第 j 轮<摘要专用标签>`，按 `interviews` 数组顺序，
//     摘要专用标签 `POST_INTERVIEW → 已面完`、`IN_PROGRESS → 面试中`，其余回退 `statusLabel`；
//   * tone 逻辑不变：跨轮取最需要注意的色档（red > amber > blue > green > gray）。
//
// 纯函数测试：不连库、不 import React（`view-model.ts` 本身即纯函数层）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { interviewSummaryOf } from '../../src/client/recruiting/view-model.ts'
import type { ChipTone } from '../../src/client/recruiting/format.ts'
import type { InterviewView } from '../../src/client/recruiting/view-model.ts'

/** `interview.status` 枚举 → 色档（与 `view-model.ts` 的全局口径一致；仅为构造合法 InterviewView）。 */
const STATUS_TONES: Readonly<Record<string, ChipTone>> = {
  SCHEDULED: 'blue',
  IN_PROGRESS: 'blue',
  POST_INTERVIEW: 'amber',
  EVALUATION_READY: 'green',
  DECIDED: 'green',
  RESCHEDULED: 'amber',
  CANCELLED: 'gray',
  NO_SHOW: 'red',
}

/**
 * 构造一轮面试（`InterviewView` 字段齐全）。
 *
 * `statusLabel` 由调用方显式给出，取 `normalizeInterview` 会产出的**全局状态机口径**
 * （POST_INTERVIEW → `面试后`），这样断言才能证明摘要文案不是简单复用该字段。
 */
function interview(roundNo: number, status: string, statusLabel: string): InterviewView {
  return {
    id: `iv-${String(roundNo)}-${status}`,
    roundNo,
    slotCode: `R${String(roundNo)}`,
    stageCode: 'S9',
    stageLabel: '面试执行与材料获取',
    status,
    statusLabel,
    statusTone: STATUS_TONES[status] ?? 'gray',
    scheduledStartAt: '',
    scheduledStartText: '',
    scheduledEndAt: '',
    scheduledEndText: '',
    timezone: 'Asia/Shanghai',
    interviewers: [],
    scorecards: {
      required: 0,
      submitted: 0,
      missing: 0,
      overdue: 0,
      summaryText: '无需面评',
      tone: 'gray',
    },
    transcript: {
      state: '',
      stateLabel: '',
      stateTone: 'gray',
      artifactId: '',
      artifactIdText: '',
      transcriptStatus: '',
      transcriptStatusLabel: '',
      transcriptStatusTone: 'gray',
      provenance: '',
      triggerMode: '',
      connectionState: '',
      labels: {
        provenance: '',
        trigger: '',
        connection: '',
        provenanceTone: 'gray',
        triggerTone: 'gray',
        connectionTone: 'gray',
        rows: [],
      },
      isComplete: false,
      isCanonical: false,
      segmentCount: 0,
      record: null,
    },
    roundFocus: {
      available: false,
      source: '',
      roundNo,
      templateVersionId: '',
      templateVersionNo: 0,
      templatePayloadHash: '',
      title: '',
      description: '',
      focusDimensions: [],
      questions: [],
      scorecardFields: [],
      reason: '',
    },
  }
}

test('O18：R1 已面完（POST_INTERVIEW）+ R2 已排期（SCHEDULED）→ 逐轮可见，不被单一状态概括', () => {
  const result = interviewSummaryOf([
    interview(1, 'POST_INTERVIEW', '面试后'),
    interview(2, 'SCHEDULED', '已排期'),
  ])
  assert.equal(result.rounds, 2)
  // 逐字：真库该申请的新摘要必须正好是这句（产品复核 O18 的验收字符串）。
  assert.equal(result.summary, '2 轮 · 第 1 轮已面完 / 第 2 轮已排期')
  // 反例守卫：旧病根文案（取最后一轮）不得再出现；也不得把状态机口径"面试后"塞进摘要。
  assert.notEqual(result.summary, '2 轮 · 已排期')
  assert.doesNotMatch(result.summary, /面试后/)
  // tone 逻辑保持原样：POST_INTERVIEW(amber) 压过 SCHEDULED(blue)。
  assert.equal(result.tone, 'amber')
})

test('O18：三轮含 IN_PROGRESS → 按轮序逐轮输出（第 1/2/3 轮各自的状态）', () => {
  const result = interviewSummaryOf([
    interview(1, 'POST_INTERVIEW', '面试后'),
    interview(2, 'IN_PROGRESS', '进行中'),
    interview(3, 'SCHEDULED', '已排期'),
  ])
  assert.equal(result.rounds, 3)
  assert.equal(result.summary, '3 轮 · 第 1 轮已面完 / 第 2 轮面试中 / 第 3 轮已排期')
  assert.equal(result.tone, 'amber')
})

test('O18：单轮保持原状（不改动用全局状态机口径的单轮文案）', () => {
  const result = interviewSummaryOf([interview(1, 'POST_INTERVIEW', '面试后')])
  assert.equal(result.rounds, 1)
  assert.equal(result.summary, '1 轮 · 面试后', '单轮仍是「N 轮 · statusLabel」，不用摘要专用标签')
  assert.equal(result.tone, 'amber')
})

test('O18：0 轮 → 未排期（grey 口径不变）', () => {
  assert.deepEqual(interviewSummaryOf([]), { rounds: 0, summary: '未排期', tone: 'gray' })
})

test('O18：摘要专用标签只覆盖 POST_INTERVIEW / IN_PROGRESS，其余回退 statusLabel', () => {
  // NO_SHOW 无摘要专用标签 → 用 InterviewView.statusLabel（`未出席`）；tone 仍是 red 优先。
  const result = interviewSummaryOf([
    interview(1, 'POST_INTERVIEW', '面试后'),
    interview(2, 'NO_SHOW', '未出席'),
  ])
  assert.equal(result.summary, '2 轮 · 第 1 轮已面完 / 第 2 轮未出席')
  assert.equal(result.tone, 'red')
})

test('O18：轮次顺序 = interviews 数组顺序（客户端不重排；服务端已按 round_no 升序投影）', () => {
  const result = interviewSummaryOf([
    interview(2, 'SCHEDULED', '已排期'),
    interview(1, 'POST_INTERVIEW', '面试后'),
  ])
  assert.equal(result.summary, '2 轮 · 第 2 轮已排期 / 第 1 轮已面完')
})

test('O18：roundNo 缺失（0）时用显示位置兜底，绝不写「第 0 轮」', () => {
  const result = interviewSummaryOf([
    interview(0, 'POST_INTERVIEW', '面试后'),
    interview(0, 'SCHEDULED', '已排期'),
  ])
  assert.equal(result.summary, '2 轮 · 第 1 轮已面完 / 第 2 轮已排期')
  assert.doesNotMatch(result.summary, /第 0 轮/)
})
