// 材料层（不连库）：issue 严重度、parse_status 映射、parsed_fields 白名单投影。
//
// 三条都直接影响判定正确性：
//   * 严重度表错 → `absent` 变得可信 → 误淘汰（SR §3.3 / R-1）。
//   * parse_status 映射错 → S7 会把"没读完"当"读完了"。
//   * 投影带了 protected_attributes → 受保护属性落库，`D11 §9.6` 的结构保证失效。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HARD_ISSUE_CODES,
  hardIssueCodes,
  isHardIssue,
  mapParseStatus,
  projectParsedFields,
} from '../../src/db/material.ts'

test('HARD issue：converter/src/issues.py 的关键 code 全部登记为 HARD', () => {
  for (const code of [
    'pdf_no_text', 'unread_visual_page', 'pdf_reading_order_unverified',
    'resume_field_unreadable', 'resume_experience_cross_block', 'encrypted_pdf',
    'platform_noise_inline_unresolved', 'pdf_damaged_repaired',
  ]) {
    assert.equal(isHardIssue(code), true, code)
    assert.ok(HARD_ISSUE_CODES.has(code), code)
  }
})

test('SOFT issue：已登记前缀与 ADDED_CODES 的 soft 项都不算 HARD', () => {
  for (const code of [
    'unverified_pdf_image', 'platform_noise_excluded', 'resume_attribution_unverified',
    'resume_timeline_unparsed', 'resume_timeline_gap', 'pdf_page_empty',
    'resume_protected_attribute_present',
  ]) {
    assert.equal(isHardIssue(code), false, code)
  }
})

test('未知 issue code 一律按 HARD（保守优先，issues.py:66-80 原话）', () => {
  assert.equal(isHardIssue('some_future_code'), true)
  assert.equal(isHardIssue(''), false)
})

test('hardIssueCodes 去重保序', () => {
  assert.deepEqual(
    hardIssueCodes([
      { code: 'pdf_no_text' }, { code: 'unread_visual_page' }, { code: 'pdf_no_text' }, {},
    ]),
    ['pdf_no_text', 'unread_visual_page'],
  )
})

test('mapParseStatus：complete + 无 HARD → PARSED；partial 或 HARD → PARTIAL；0 字 → FAILED', () => {
  assert.deepEqual(mapParseStatus('complete', 1200, []), { status: 'PARSED' })
  assert.deepEqual(mapParseStatus('partial', 2028, [{ code: 'unverified_pdf_image' }]), { status: 'PARTIAL' })
  assert.deepEqual(mapParseStatus('complete', 1200, [{ code: 'pdf_no_text' }]), { status: 'PARTIAL' })
  const failed = mapParseStatus('partial', 0, [{ code: 'pdf_no_text' }])
  assert.equal(failed.status, 'FAILED')
  assert.equal(failed.parse_error, 'pdf_no_text', 'ck_resume_version_error 要求 parse_error 非空')
})

test('projectParsedFields：白名单只留 fields/timeline/issues/screening/meta，protected 一律不落库', () => {
  const projection = projectParsedFields({
    fields: { phone: { state: 'present', value: 'x' } },
    timeline: { covered_months_closed: 74 },
    issues: [{ code: 'unverified_pdf_image', message: 'm', location: { page: 1 } }],
    screening: { eligible_fields: ['phone'], blocked_fields: [] },
    meta: { pages: 2, source_sha256: 'a'.repeat(64), backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
    // 下面这两个**故意**传进来，必须被丢掉
    protected_attributes: { gender: { value: 'x' } },
    noise: [{ text: 'BOSS直聘' }],
  } as Parameters<typeof projectParsedFields>[0] & Record<string, unknown>)

  const keys = Object.keys(projection).sort()
  assert.deepEqual(keys, ['fields', 'issues', 'meta', 'screening', 'timeline'])
  const text = JSON.stringify(projection)
  assert.equal(text.includes('protected'), false, '受保护属性不得进入 parsed_fields')
  assert.equal(text.includes('BOSS直聘'), false, '平台噪声不落库')
  // issue 只保留 code/message，location 不进库（避免把整页坐标当事实）
  assert.deepEqual(projection.issues, [{ code: 'unverified_pdf_image', message: 'm' }])
  assert.equal(projection.meta.pages, 2)
})

test('D-98：pdf_text_recovered_by_ocr 是**恢复成功**标记（SOFT），不得把 parse_status 降级', () => {
  // 实测回归（P1-3）：mapParseStatus('complete', 1000, [recovered]) 曾返回 PARTIAL ——
  // 因为未知 code 一律按 HARD。这正是 D-98 说的"恢复成功被当成失败"。
  assert.equal(isHardIssue('pdf_text_recovered_by_ocr'), false)
  assert.deepEqual(hardIssueCodes([{ code: 'pdf_text_recovered_by_ocr' }]), [])
  assert.deepEqual(
    mapParseStatus('complete', 1000, [{ code: 'pdf_text_recovered_by_ocr' }]),
    { status: 'PARSED' },
    '整页 OCR 已补齐正文 → 仍是 PARSED；降成 PARTIAL 等于"恢复成功反而被当成没读完"',
  )
  // 恢复标记不能掩盖真的 HARD：两者同时出现时 HARD 仍然生效
  assert.deepEqual(
    mapParseStatus('complete', 1000, [{ code: 'pdf_text_recovered_by_ocr' }, { code: 'pdf_no_text' }]),
    { status: 'PARTIAL' },
  )
  assert.deepEqual(
    mapParseStatus('partial', 0, [{ code: 'pdf_text_recovered_by_ocr' }]),
    { status: 'FAILED', parse_error: 'pdf_no_text' },
    '一个字符都没有时仍是 FAILED（恢复标记不提供 parse_error）',
  )
})

test('projectParsedFields：缺省输入产出稳定形状（fields={} / issues=[] / pages=0）', () => {
  const projection = projectParsedFields({})
  assert.deepEqual(projection.fields, {})
  assert.deepEqual(projection.issues, [])
  assert.equal(projection.meta.pages, 0)
  assert.equal(Object.hasOwn(projection, 'timeline'), false, '没有 timeline 就省略这个键')
})
