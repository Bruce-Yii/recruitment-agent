// 工作空间设置的**纯校验**单测（docs/34 §二.2-5）：三组设置中可写的两组 + 人工确认原话。
// 外部连接状态只读（值来自现有配置解析），本文件刻意不测它——它不可写，不能假装已连接。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SLA_HOURS_MAX,
  SLA_HOURS_MIN,
  SETTINGS_CONFIRMATION_TEXT_MAX,
  WORKSPACE_SETTING_KEYS,
  isWorkspaceSettingKey,
  validateConfirmationText,
  validateSlaThresholds,
  validateSilentDelegation,
  validateWorkspaceSettingValue,
} from '../../src/domain/tenant-config.ts'

/** 抽 `Error: <CODE>: <compact-json>` 里的 reason_code（与既有 config 测试同手法）。 */
function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const index = message.indexOf(': ')
    if (index > 0) {
      try {
        const body = JSON.parse(message.slice(index + 2)) as { reason_code?: string }
        if (typeof body.reason_code === 'string') return body.reason_code
      } catch {
        // 落到下面的断言失败
      }
    }
  }
  assert.fail('期望抛出带 reason_code 的契约错误，实际没有')
}

test('可写设置键封闭集：只有两项，不含外部连接状态', () => {
  assert.deepEqual([...WORKSPACE_SETTING_KEYS], ['agent_silent_delegation', 'sla_thresholds'])
  assert.equal(isWorkspaceSettingKey('agent_silent_delegation'), true)
  assert.equal(isWorkspaceSettingKey('sla_thresholds'), true)
  assert.equal(isWorkspaceSettingKey('email_connection'), false)
  assert.equal(isWorkspaceSettingKey('feishu_calendar_connection'), false)
  assert.equal(isWorkspaceSettingKey('feishu_minutes_connection'), false)
})

test('validateSilentDelegation：只收布尔，字符串/数字/undefined 都拒', () => {
  assert.equal(validateSilentDelegation(true), true)
  assert.equal(validateSilentDelegation(false), false)
  assert.equal(reasonOf(() => validateSilentDelegation('true')), 'SILENT_DELEGATION_NOT_BOOLEAN')
  assert.equal(reasonOf(() => validateSilentDelegation(1)), 'SILENT_DELEGATION_NOT_BOOLEAN')
  assert.equal(reasonOf(() => validateSilentDelegation(undefined)), 'SILENT_DELEGATION_NOT_BOOLEAN')
})

test('validateSlaThresholds：合法对象原样归一化', () => {
  assert.deepEqual(validateSlaThresholds({ screening_hours: 8, scorecard_hours: 24 }), {
    screening_hours: 8,
    scorecard_hours: 24,
  })
  assert.deepEqual(validateSlaThresholds({ screening_hours: SLA_HOURS_MIN, scorecard_hours: SLA_HOURS_MAX }), {
    screening_hours: SLA_HOURS_MIN,
    scorecard_hours: SLA_HOURS_MAX,
  })
})

test('validateSlaThresholds：负数 / 超大 / 非整数 / 缺字段 / 未知字段都拒（负例零写入的前置）', () => {
  assert.equal(reasonOf(() => validateSlaThresholds({ screening_hours: -1, scorecard_hours: 24 })), 'SCREENING_HOURS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateSlaThresholds({ screening_hours: 8, scorecard_hours: 0 })), 'SCORECARD_HOURS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateSlaThresholds({ screening_hours: 8, scorecard_hours: 999999 })), 'SCORECARD_HOURS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateSlaThresholds({ screening_hours: 1.5, scorecard_hours: 24 })), 'SCREENING_HOURS_NOT_INTEGER')
  assert.equal(reasonOf(() => validateSlaThresholds({ screening_hours: '8', scorecard_hours: 24 })), 'SCREENING_HOURS_NOT_INTEGER')
  assert.equal(reasonOf(() => validateSlaThresholds({ screening_hours: 8 })), 'SLA_THRESHOLDS_MISSING_FIELD')
  assert.equal(reasonOf(() => validateSlaThresholds({ screening_hours: 8, scorecard_hours: 24, extra: 1 })), 'SLA_THRESHOLDS_UNKNOWN_FIELD')
  assert.equal(reasonOf(() => validateSlaThresholds([])), 'SLA_THRESHOLDS_NOT_OBJECT')
  assert.equal(reasonOf(() => validateSlaThresholds(null)), 'SLA_THRESHOLDS_NOT_OBJECT')
})

test('validateWorkspaceSettingValue：按 key 分派，未知/只读键拒绝', () => {
  assert.equal(validateWorkspaceSettingValue('agent_silent_delegation', false), false)
  assert.deepEqual(validateWorkspaceSettingValue('sla_thresholds', { screening_hours: 4, scorecard_hours: 12 }), {
    screening_hours: 4,
    scorecard_hours: 12,
  })
  assert.equal(reasonOf(() => validateWorkspaceSettingValue('email_connection', true)), 'SETTING_KEY_UNKNOWN')
  assert.equal(reasonOf(() => validateWorkspaceSettingValue('unknown_key', true)), 'SETTING_KEY_UNKNOWN')
})

test('validateConfirmationText：1..2000 非空原话；哈希由服务端算，这里只校验文本', () => {
  assert.equal(validateConfirmationText('  确认修改  '), '确认修改')
  assert.equal(SETTINGS_CONFIRMATION_TEXT_MAX, 2000)
  assert.equal(reasonOf(() => validateConfirmationText('')), 'CONFIRMATION_TEXT_LENGTH')
  assert.equal(reasonOf(() => validateConfirmationText('   ')), 'CONFIRMATION_TEXT_LENGTH')
  assert.equal(reasonOf(() => validateConfirmationText('x'.repeat(2001))), 'CONFIRMATION_TEXT_LENGTH')
  assert.equal(reasonOf(() => validateConfirmationText(123)), 'CONFIRMATION_TEXT_NOT_STRING')
})
