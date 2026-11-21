// ASYNC-2「失败看得见」单测：tasks/status 投影在失败任务行上暴露 error_code / error_summary。
// 不连库：用最小 DatabaseClient 替身返回一条 FAILED 行，其余查询返回空（只读投影不写库）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { readTasksStatusProjection } from '../../src/http/display-tasks.ts'

interface FakeResult<T> { rows: T[] }
function fakeClient(row: Record<string, unknown>) {
  return {
    async query<T>(sql: string): Promise<FakeResult<T>> {
      if (sql.includes('from recruitment.business_task bt')) {
        return { rows: [row as T] }
      }
      if (/select now\(\)/.test(sql)) {
        return { rows: [{ now_ts: new Date().toISOString() } as T] }
      }
      return { rows: [] }
    },
  } as never
}

const FAILED_ROW = {
  task_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  task_type: 'RESUME_PARSE',
  title: '解析新收到的简历',
  status: 'FAILED',
  priority: 3,
  attempt_count: 1,
  created_at: new Date().toISOString(),
  status_changed_at: new Date().toISOString(),
  next_run_at: new Date().toISOString(),
  due_at: null,
  business_refs: [],
  error_code: 'PARSE_FAILED',
  error_summary: '简历解析失败（未入库）：文件损坏，无法读取内容',
  current_attempt_no: null,
  current_attempt_status: null,
  current_attempt_lease_expires_at: null,
  current_attempt_claimed_at: null,
}

test('失败任务在 tasks/status 投影里带 error_code + 人话 error_summary（只加字段不改契约）', async () => {
  const body = await readTasksStatusProjection(fakeClient(FAILED_ROW), '11111111-1111-4111-8111-000000000001')
  const row = body.tasks.find((item) => item.task_id === FAILED_ROW.task_id)
  assert.ok(row !== undefined, '失败任务必须出现在 tasks 列表里')
  assert.equal(row.status, 'FAILED')
  assert.equal(row.error_code, 'PARSE_FAILED')
  assert.match(String(row.error_summary), /解析失败|无法读取|未入库/)
  // 既有字段一个都不许被替换/删掉
  assert.equal(row.task_type, 'RESUME_PARSE')
  assert.equal(row.title, '解析新收到的简历')
  assert.equal(typeof row.attempt_count, 'number')
})
