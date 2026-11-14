// 工具规范输出的形状约束（node --test 直接跑 .ts，靠 Node 的类型擦除）。
//
// 为什么需要这一层：DSH 注册表会用 output.schema 强制校验 execute() 的返回值，
// 不符合就整次调用失败（Error: tool "<name>" returned invalid output ...，
// code=INVALID_TOOL_OUTPUT）。而 DSH 的 JSON Schema 子集**不支持 type 数组**
// （dsh-tools/lib/types/json-schema.js:245「type arrays are not supported」），
// 所以 `value: string | null` 这种写法会让工具在真实运行时 100% 调用失败。
//
// 2026-11-13 第一次真实 headless 调用就撞上了这个：
//   Error: tool "recruitment_resume_read" returned invalid output:
//   "value.fields.work_experience.value" must be a string;
//   "value.fields.education.value" must be a string
// 单测当时是 68/68 全绿——因为它们只测 structure/，从没碰过工具的输出。
//
// 本文件的规则只有一条：**工具输出里不允许出现 null**。
// 缺失用「省略这个键」表达，不用 null。这条规则可机械检查，也正好挡住上面那类回归。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createResumeReadTool, toValue } from '../../src/tools/resume-read.ts'

/** 深扫：返回所有值为 null 的路径（数组下标用 [i]）。 */
function nullPaths(value: unknown, path = 'value'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => nullPaths(item, `${path}[${i}]`))
  }
  if (typeof value === 'object' && value !== undefined) {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([k, v]) => nullPaths(v, `${path}.${k}`))
  }
  return []
}

const BASE_OUTPUT = {
  text: '张三 13800000000',
  completeness: 'partial',
  needs_visual: false,
  issues: [{ code: 'resume_timeline_unparsed', message: 'timeline not parsed' }],
  blocks: [
    { kind: 'paragraph', text: '张三', location: { page: 1, bbox: [1, 2, 3, 4] } },
  ],
  meta: {
    pages: 1,
    source_name: 'x.pdf',
    source_sha256: 'a'.repeat(64),
    backend: 'pymupdf/1.28.0',
    order_verified: false,
  },
} as const

test('O1 三元组里 absent / unreadable 不带 value，且输出里没有任何 null', () => {
  const value = toValue(
    {
      ...BASE_OUTPUT,
      fields: {
        name: { state: 'present', value: '张三', reason: '', evidence: [{ page: 1, bbox: [1, 2, 3, 4], block: 0, text: '张三' }] },
        phone: { state: 'absent', reason: 'no_phone_found', evidence: [] },
        email: { state: 'unreadable', reason: 'reading_order_unverified', evidence: [] },
        work_experience: { state: 'unreadable', value: null, reason: 'reading_order_unverified', evidence: [] },
        education: { state: 'absent', value: null, reason: 'entries_not_segmentable', evidence: [] },
      },
    },
    40,
  )

  assert.deepEqual(nullPaths(value), [], '工具输出不得出现 null（DSH 校验器不支持 type 数组）')

  assert.equal(value.fields.name.state, 'present')
  assert.equal(value.fields.name.value, '张三')
  // absent / unreadable 必须整个键省略，而不是给 null 或空串。
  for (const name of ['phone', 'email', 'work_experience', 'education'] as const) {
    assert.equal('value' in value.fields[name], false, `${name}.value 不应存在`)
    assert.notEqual(value.fields[name].state, 'present')
  }
})

test('O2 转换器给了 null value 时也不能漏出 null', () => {
  const value = toValue(
    {
      ...BASE_OUTPUT,
      fields: { name: { state: 'present', value: null, reason: '', evidence: [] } },
    },
    40,
  )
  assert.deepEqual(nullPaths(value), [])
  // state=present 但 value 不是字符串：降级成「省略 value」，状态不变（不把 present 改成 absent）。
  assert.equal(value.fields.name.state, 'present')
  assert.equal('value' in value.fields.name, false)
})

test('O3 字段缺失 / 未知 state 一律按 unreadable，绝不当成 absent', () => {
  const value = toValue({ ...BASE_OUTPUT, fields: {} }, 40)
  for (const name of ['name', 'phone', 'email', 'work_experience', 'education'] as const) {
    assert.equal(value.fields[name].state, 'unreadable', `${name} 缺字段时必须是 unreadable`)
  }
  const weird = toValue({ ...BASE_OUTPUT, fields: { name: { state: 'banana' } } }, 40)
  assert.equal(weird.fields.name.state, 'unreadable')
  assert.equal(weird.fields.name.reason, 'state_missing_from_converter')
  assert.deepEqual(nullPaths(weird), [])
})

test('O4 render 不打印 undefined / null 字面量', () => {
  const value = toValue(
    {
      ...BASE_OUTPUT,
      fields: {
        name: { state: 'present', value: '张三', evidence: [] },
        work_experience: { state: 'unreadable', reason: 'reading_order_unverified', evidence: [] },
      },
    },
    40,
  )
  // render 是纯函数（(args, value) -> 文本块），不需要真的跑 Python：
  // 造一个只用于 render 的工具实例即可。
  const tool = createResumeReadTool({
    python_bin: 'C:\\python.exe',
    converter_dir: 'C:\\converter',
    allowed_roots: ['C:\\corpus'],
    timeout_ms: 1000,
  })
  const blocks = tool.output.render(undefined, value)
  const text = blocks.map((b) => b.text).join('\n')
  assert.equal(text.includes('undefined'), false, `render 里出现了 undefined：\n${text}`)
  assert.equal(text.includes('null'), false, `render 里出现了 null：\n${text}`)
  assert.match(text, /work_experience: unreadable \(reading_order_unverified\)/)
})

test('O5 输出 schema 声明的每个字段都真的存在于规范值里', () => {
  const value = toValue({ ...BASE_OUTPUT, fields: {} }, 40) as unknown as Record<string, unknown>
  for (const key of [
    'provenance', 'provenance_basis', 'stub', 'source', 'blocks', 'block_count', 'truncated',
    'fields', 'screening', 'issues', 'needs_visual',
  ]) {
    assert.equal(key in value, true, `输出缺少 schema 要求的键 ${key}`)
  }
  const source = value.source as Record<string, unknown>
  for (const key of ['file_name', 'media_type', 'pages', 'sha256', 'backend', 'order_verified', 'completeness']) {
    assert.equal(key in source, true, `source 缺少 schema 要求的键 ${key}`)
  }
})
