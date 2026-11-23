// 工作空间设置的**纯校验**单测（docs/34 §二.2-5）：三组设置中可写的两组 + 人工确认原话。
// 外部连接状态只读（值来自现有配置解析），本文件刻意不测它——它不可写，不能假装已连接。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SLA_HOURS_MAX,
  SLA_HOURS_MIN,
  SETTINGS_CONFIRMATION_TEXT_MAX,
  WORKSPACE_SETTING_DEFAULTS,
  WORKSPACE_SETTING_KEYS,
  isWorkspaceSettingKey,
  validateBookingInviteDefaults,
  validateConfirmationText,
  validateScorecardReminderPolicy,
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

test('可写设置键封闭集：六项，不含外部连接状态', () => {
  assert.deepEqual([...WORKSPACE_SETTING_KEYS], [
    'agent_silent_delegation', 'sla_thresholds', 'auto_screening_enabled',
    'auto_scorecard_draft_enabled', 'scorecard_reminder_policy', 'booking_invite_defaults',
  ])
  assert.deepEqual(Object.keys(WORKSPACE_SETTING_DEFAULTS), [...WORKSPACE_SETTING_KEYS])
  assert.equal(isWorkspaceSettingKey('agent_silent_delegation'), true)
  assert.equal(isWorkspaceSettingKey('sla_thresholds'), true)
  assert.equal(isWorkspaceSettingKey('auto_screening_enabled'), true)
  assert.equal(isWorkspaceSettingKey('auto_scorecard_draft_enabled'), true)
  assert.equal(isWorkspaceSettingKey('scorecard_reminder_policy'), true)
  assert.equal(isWorkspaceSettingKey('booking_invite_defaults'), true)
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

test('诚实缺省：四个新增键的默认值逐字段固定', () => {
  assert.deepEqual(WORKSPACE_SETTING_DEFAULTS.auto_screening_enabled, true)
  assert.deepEqual(WORKSPACE_SETTING_DEFAULTS.auto_scorecard_draft_enabled, true)
  assert.deepEqual(WORKSPACE_SETTING_DEFAULTS.scorecard_reminder_policy, {
    enabled: true, overdue_hours: 24, max_reminders: 2, channel: 'workbench',
  })
  assert.deepEqual(WORKSPACE_SETTING_DEFAULTS.booking_invite_defaults, {
    expires_hours: 72, default_duration_min: 60,
  })
})

test('validateWorkspaceSettingValue：新增两布尔键严格 boolean', () => {
  assert.equal(validateWorkspaceSettingValue('auto_screening_enabled', true), true)
  assert.equal(validateWorkspaceSettingValue('auto_screening_enabled', false), false)
  assert.equal(validateWorkspaceSettingValue('auto_scorecard_draft_enabled', false), false)
  assert.equal(reasonOf(() => validateWorkspaceSettingValue('auto_screening_enabled', 'true')), 'AUTO_SCREENING_ENABLED_NOT_BOOLEAN')
  assert.equal(reasonOf(() => validateWorkspaceSettingValue('auto_scorecard_draft_enabled', 0)), 'AUTO_SCORECARD_DRAFT_ENABLED_NOT_BOOLEAN')
})

test('validateScorecardReminderPolicy：合法对象归一化（含/不含 quiet_hours）', () => {
  assert.deepEqual(validateScorecardReminderPolicy({ enabled: true, overdue_hours: 24, max_reminders: 2, channel: 'workbench' }), {
    enabled: true, overdue_hours: 24, max_reminders: 2, channel: 'workbench',
  })
  assert.deepEqual(validateScorecardReminderPolicy({
    enabled: false, overdue_hours: 72, max_reminders: 5, channel: 'email',
    quiet_hours: { start: '20:00', end: '09:00' },
  }), {
    enabled: false, overdue_hours: 72, max_reminders: 5, channel: 'email',
    quiet_hours: { start: '20:00', end: '09:00' },
  })
})

test('validateScorecardReminderPolicy：非法枚举/越界/缺字段/未知字段/坏 quiet_hours 全拒', () => {
  const base = { enabled: true, overdue_hours: 24, max_reminders: 2, channel: 'workbench' }
  assert.equal(reasonOf(() => validateScorecardReminderPolicy(null)), 'SCORECARD_REMINDER_POLICY_NOT_OBJECT')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy([])), 'SCORECARD_REMINDER_POLICY_NOT_OBJECT')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, extra: 1 })), 'SCORECARD_REMINDER_POLICY_UNKNOWN_FIELD')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ enabled: true })), 'SCORECARD_REMINDER_POLICY_MISSING_FIELD')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, enabled: 'true' })), 'REMINDER_ENABLED_NOT_BOOLEAN')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, overdue_hours: 12 })), 'REMINDER_OVERDUE_HOURS_INVALID')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, max_reminders: 0 })), 'REMINDER_MAX_REMINDERS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, max_reminders: 6 })), 'REMINDER_MAX_REMINDERS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, max_reminders: 1.5 })), 'REMINDER_MAX_REMINDERS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, channel: 'sms' })), 'REMINDER_CHANNEL_INVALID')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, quiet_hours: { start: '20:00', end: '09:00', extra: 1 } })), 'QUIET_HOURS_UNKNOWN_FIELD')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, quiet_hours: { start: '24:00', end: '09:00' } })), 'QUIET_HOURS_START_INVALID')
  assert.equal(reasonOf(() => validateScorecardReminderPolicy({ ...base, quiet_hours: { start: '09:00', end: '09:00' } })), 'QUIET_HOURS_SAME_START_END')
})

test('validateBookingInviteDefaults：合法边界值 + 非法值 fail-closed', () => {
  assert.deepEqual(validateBookingInviteDefaults({ expires_hours: 24, default_duration_min: 30 }), { expires_hours: 24, default_duration_min: 30 })
  assert.deepEqual(validateBookingInviteDefaults({ expires_hours: 168, default_duration_min: 90 }), { expires_hours: 168, default_duration_min: 90 })
  assert.equal(reasonOf(() => validateBookingInviteDefaults(null)), 'BOOKING_INVITE_DEFAULTS_NOT_OBJECT')
  assert.equal(reasonOf(() => validateBookingInviteDefaults({ expires_hours: 23, default_duration_min: 60 })), 'BOOKING_EXPIRES_HOURS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateBookingInviteDefaults({ expires_hours: 169, default_duration_min: 60 })), 'BOOKING_EXPIRES_HOURS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateBookingInviteDefaults({ expires_hours: 72.5, default_duration_min: 60 })), 'BOOKING_EXPIRES_HOURS_OUT_OF_RANGE')
  assert.equal(reasonOf(() => validateBookingInviteDefaults({ expires_hours: 72, default_duration_min: 45, extra: true })), 'BOOKING_INVITE_DEFAULTS_UNKNOWN_FIELD')
  assert.equal(reasonOf(() => validateBookingInviteDefaults({ expires_hours: 72 })), 'BOOKING_INVITE_DEFAULTS_MISSING_FIELD')
  assert.equal(reasonOf(() => validateWorkspaceSettingValue('booking_invite_defaults', { expires_hours: 72, default_duration_min: 50 })), 'BOOKING_DURATION_INVALID')
})

test('validateConfirmationText：1..2000 非空原话；哈希由服务端算，这里只校验文本', () => {
  assert.equal(validateConfirmationText('  确认修改  '), '确认修改')
  assert.equal(SETTINGS_CONFIRMATION_TEXT_MAX, 2000)
  assert.equal(reasonOf(() => validateConfirmationText('')), 'CONFIRMATION_TEXT_LENGTH')
  assert.equal(reasonOf(() => validateConfirmationText('   ')), 'CONFIRMATION_TEXT_LENGTH')
  assert.equal(reasonOf(() => validateConfirmationText('x'.repeat(2001))), 'CONFIRMATION_TEXT_LENGTH')
  assert.equal(reasonOf(() => validateConfirmationText(123)), 'CONFIRMATION_TEXT_NOT_STRING')
})
