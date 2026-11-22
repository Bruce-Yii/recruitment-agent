// Issue #25 / G-02 自动分岗单测：精确编码 / 唯一标题 / 未命中与多义 fail-closed。
// 纯函数测试，不连库不连网络。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveJobForMail,
  extractJobCodeTokens,
  normalizeJobTitle,
  toJobCandidates,
  type MailJobCandidate,
} from '../../src/connectors/mail/match.ts'

const JOBS: readonly MailJobCandidate[] = [
  { id: 'job-be', code: 'DEMO-BE-001', title: '后端工程师', status: 'OPEN' },
  { id: 'job-fe', code: 'JOB-20261114-77CD5B', title: '前端工程师', status: 'OPEN' },
  { id: 'job-pm', code: 'PM-009', title: '产品经理', status: 'OPEN' },
  { id: 'job-closed', code: 'OLD-BE-999', title: '后端工程师', status: 'CLOSED' },
]

test('精确岗位编码命中（DEMO-BE-001 / JOB-XXXXXX）优先于标题', () => {
  const a = resolveJobForMail('应聘 DEMO-BE-001 后端工程师', '简历见附件', JOBS)
  assert.deepEqual(a, { matched: true, job_id: 'job-be', strategy: 'EXACT_CODE' })

  const b = resolveJobForMail('投递', '请考虑 JOB-20261114-77CD5B 职位', JOBS)
  assert.deepEqual(b, { matched: true, job_id: 'job-fe', strategy: 'EXACT_CODE' })

  // 即使标题也能匹配别的岗位，编码优先。
  const c = resolveJobForMail('后端工程师，但我想应聘 JOB-20261114-77CD5B', '', JOBS)
  assert.equal(c.matched, true)
  if (c.matched) assert.equal(c.job_id, 'job-fe')
})

test('编码大小写/标点边界不误命中子串，也不命中非在招岗位', () => {
  assert.equal(resolveJobForMail('应聘 demo-be-001', '', JOBS).matched, true)
  // 更长编码不能命中短编码；OLD-BE-999 岗位已 CLOSED。
  const longer = resolveJobForMail('JOB-20261114-77CD5B-X 相关', '', JOBS)
  assert.deepEqual(longer, { matched: false, unmatched_reason: 'NO_CODE_OR_TITLE_MATCH' })
  assert.equal(resolveJobForMail('OLD-BE-999', '', JOBS).matched, false)
})

test('唯一标题命中：规范化后连续子串，且仅一个在招岗位', () => {
  const r = resolveJobForMail('应聘岗位：高级 后端工程师（社招）', '', JOBS)
  assert.deepEqual(r, { matched: true, job_id: 'job-be', strategy: 'UNIQUE_TITLE' })

  // 别名/标点差异不影响：normalizeJobTitle 去空白与标点。
  assert.equal(normalizeJobTitle('高级 后端 工程师'), '高级后端工程师')
})

test('未命中/无在招岗位 fail-closed + unmatched_reason', () => {
  assert.deepEqual(resolveJobForMail('我要应聘 运维工程师', '', JOBS), {
    matched: false, unmatched_reason: 'NO_CODE_OR_TITLE_MATCH',
  })
  assert.deepEqual(resolveJobForMail('DEMO-BE-001', '', []), {
    matched: false, unmatched_reason: 'NO_OPEN_JOBS',
  })
})

test('多义 fail-closed：多个编码 / 多个标题都不挂岗', () => {
  const codes = resolveJobForMail('DEMO-BE-001 与 JOB-20261114-77CD5B 哪个在招？', '', JOBS)
  assert.deepEqual(codes, { matched: false, unmatched_reason: 'AMBIGUOUS_CODE' })

  // CLOSED 的岗位不参与标题歧义：两个 OPEN 的标题同时出现才算多义。
  const titles = resolveJobForMail('后端工程师 和 前端工程师 我都投了', '', JOBS)
  assert.deepEqual(titles, { matched: false, unmatched_reason: 'AMBIGUOUS_TITLE' })
})

test('toJobCandidates 只保留 OPEN 且字段完整的岗位', () => {
  const rows = [
    { id: 'a', code: 'A-001', title: '甲', status: 'OPEN' },
    { id: 'b', code: 'B-001', title: '乙', status: 'CLOSED' },
    { id: '', code: 'C-001', title: '丙', status: 'OPEN' },
    { id: 'd', code: '', title: '', status: 'OPEN' },
    null,
  ]
  assert.deepEqual(toJobCandidates(rows), [
    { id: 'a', code: 'A-001', title: '甲', status: 'OPEN' },
  ])
})

test('extractJobCodeTokens 抽取去重，过滤噪声', () => {
  assert.deepEqual(extractJobCodeTokens('DEMO-BE-001 / demo-be-001 / 后端工程师'), ['DEMO-BE-001', 'demo-be-001'])
  assert.deepEqual(extractJobCodeTokens('没有编码'), [])
})
