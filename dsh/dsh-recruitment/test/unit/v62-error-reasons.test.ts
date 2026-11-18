// V6-2：终态失败任务的「需要人处理」判定 + error_code → 人话映射（纯函数单测，不连库）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GENERIC_FAILURE_REASON,
  HUMAN_ERROR_CLASSES,
  humanizeFailureReason,
  needsHuman,
} from '../../src/http/error-reasons.ts'

// ---------------------------------------------------------------------------
//  1. error_class 闭集
// ---------------------------------------------------------------------------

test('needsHuman：四个纳入类必须全 true（V6-2 判据）', () => {
  for (const cls of ['PERMANENT', 'INVALID_INPUT', 'AUTH_REQUIRED', 'BUSINESS_CONFLICT']) {
    assert.equal(needsHuman(cls), true, `${cls} 应需要人处理`)
  }
})

test('needsHuman：WORKER_LOST / TIMEOUT / TRANSIENT / WAIT_EXTERNAL / UNKNOWN_OUTCOME 全 false', () => {
  for (const cls of ['WORKER_LOST', 'TIMEOUT', 'TRANSIENT', 'WAIT_EXTERNAL', 'UNKNOWN_OUTCOME']) {
    assert.equal(needsHuman(cls), false, `${cls} 不应进人工队列`)
  }
})

test('needsHuman：大小写不敏感；null / undefined / 非字符串一律 false', () => {
  assert.equal(needsHuman('permanent'), true)
  assert.equal(needsHuman('  Auth_Required  '), false, '带空格不匹配闭集（SQL 也不会）')
  assert.equal(needsHuman(null), false)
  assert.equal(needsHuman(undefined), false)
  assert.equal(needsHuman(''), false)
  assert.equal(needsHuman(42 as unknown as string), false)
})

test('HUMAN_ERROR_CLASSES 恰好四个且与判据一致（收紧：不许悄悄扩集）', () => {
  assert.deepEqual([...HUMAN_ERROR_CLASSES].sort(), [
    'AUTH_REQUIRED', 'BUSINESS_CONFLICT', 'INVALID_INPUT', 'PERMANENT',
  ])
  for (const cls of HUMAN_ERROR_CLASSES) assert.equal(needsHuman(cls), true)
})

// ---------------------------------------------------------------------------
//  2. error_code → 人话
// ---------------------------------------------------------------------------

test('humanizeFailureReason：四个已知 code 给规定人话，且不含机器码', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['UNKNOWN_MODEL', '模型配置不正确，这次没能读出来'],
    ['INVALID_INPUT', '这个文件没法处理'],
    ['AUTH_REQUIRED', '外部账号未就绪'],
    ['BUSINESS_CONFLICT', '和已有事实冲突，需要你确认'],
  ]
  for (const [code, expected] of cases) {
    const reason = humanizeFailureReason(code)
    assert.equal(reason, expected)
    assert.equal(reason.includes(code), false, '人话里不许出现机器码')
  }
})

test('humanizeFailureReason：未知 code / 空值一律通用兜底人话（不暴露 code）', () => {
  for (const code of ['SOMETHING_NEW', 'E500', '', '   ', null, undefined]) {
    assert.equal(humanizeFailureReason(code), GENERIC_FAILURE_REASON)
  }
  assert.equal(GENERIC_FAILURE_REASON.length > 0, true)
})

test('humanizeFailureReason：大小写容错（历史写法），但永远返回非空人话', () => {
  assert.equal(humanizeFailureReason('unknown_model'), '模型配置不正确，这次没能读出来')
  assert.equal(humanizeFailureReason('business_conflict'), '和已有事实冲突，需要你确认')
  for (const code of ['X', 'Y', 'Z']) {
    assert.equal(humanizeFailureReason(code).length > 0, true)
  }
})
