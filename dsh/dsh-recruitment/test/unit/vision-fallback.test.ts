// 模型兜底两步（D-81）的单测：不联网、不调模型、不写库。
//
// 覆盖四层：
//   1. 契约层：两个工具的参数/输出 schema 只用 DSH 支持的子集关键字（无 type 数组、
//      无 type:'null'、required ⊆ properties），且 closed object root；
//   2. 纯映射层：桥返回 → 工具输出的归一化（缺字段退化、不自相矛盾、无 null）；
//   3. 失败层：未配置时 NOT_CONFIGURED、参数非法时 INVALID_ARGS、桥错误码映射；
//   4. 真实 Python 路径：用本机 python + converter/fallback 真跑一次
//      渲染 + 校验 + 合并（拒绝路径逐条核对，并断言拒绝消息里不含原文）。
//
// 第 4 层需要本机 python 与 converter/；缺任何一项时 test.skip()，不伪装成通过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, inject as pluginInject } from '../../src/index.ts'
import { resolveConverterConfig } from '../../src/tools/converter.ts'
import { bridgeFailure } from '../../src/tools/fallback-bridge.ts'
import {
  createPageImageTool,
  toPageImageValue,
  unconfiguredPageImageTool,
} from '../../src/tools/page-image.ts'
import {
  createModelTextMergeTool,
  routedModelId,
  toModelTextMergeValue,
  unconfiguredModelTextMergeTool,
} from '../../src/tools/vision-fallback.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONVERTER_DIR = resolve(HERE, '..', '..', '..', '..', 'converter')
const PYTHON = 'D:\\Python3.12.9\\python.exe'
const CAN_RUN_PYTHON = existsSync(PYTHON)
  && existsSync(join(CONVERTER_DIR, 'fallback', 'merge.py'))
  && existsSync(join(CONVERTER_DIR, 'src', 'cli.py'))

/** 生成一份「只有图、没有文本层」的合成页：校验路径里 overlap 检查会被记为 skipped。 */
const MAKE_PDF = String.raw`
import sys
from pathlib import Path
import fitz

out = Path(sys.argv[1])
font = r"C:\Windows\Fonts\simhei.ttf"
lines = [
    ("SYNTHETIC SAMPLE - NOT A REAL RESUME", 11.0),
    ("Candidate Example A", 18.0),
    ("Phone: 138-0000-0000   Email: demo.candidate@example.invalid", 11.5),
    ("Work experience", 13.0),
    ("2021.07 - 2024.06  Example Technology Ltd  Backend Engineer", 11.5),
    ("- split the order service; P99 went from 480ms to 120ms", 11.5),
    ("Education", 13.0),
    ("2015.09 - 2019.06  Example University  Computer Science  BSc", 11.5),
]
source = out.with_name("source.pdf")
doc = fitz.open()
page = doc.new_page(width=595, height=842)
y = 70.0
for text, size in lines:
    page.insert_text((50, y), text, fontsize=size, fontname="cjk" if font else "helv",
                     fontfile=font if font else None)
    y += size * 1.6 + 2.0
doc.save(str(source))
doc.close()

src = fitz.open(str(source))
pix = src[0].get_pixmap(dpi=200, alpha=False)
jpeg = pix.tobytes("jpg", jpg_quality=88)
src.close()

final = fitz.open()
fpage = final.new_page(width=595, height=842)
fpage.insert_image(fpage.rect, stream=jpeg)
final.save(str(out), deflate=True, garbage=4)
final.close()

check = fitz.open(str(out))
print("chars=", len(check[0].get_text().strip()), "pages=", check.page_count)
`

/** 在系统 temp 下造一份一页的 image-only PDF。 */
function makeImageOnlyPdf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recruitment-vision-test-'))
  const pdf = join(dir, 'synthetic-vision.pdf')
  execFileSync(PYTHON, ['-c', MAKE_PDF, pdf], { encoding: 'utf8', timeout: 60_000 })
  return pdf
}

/** 本文件只用到这些 schema 关键字（`json-schema.js` 的 CONSTRAINT_KEYWORDS + annotations）。 */
const SUPPORTED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

/** 深扫 schema：子集外关键字 / type 数组 / type:'null' / required 未声明。 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [`${path} 不是对象`]
  const node = schema as Record<string, unknown>
  const out: string[] = []
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const type = node.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组（DSH 不支持 type 数组）`)
  else if (typeof type === 'string') {
    if (!TYPES.has(type)) out.push(`${path}.type=${type} 不是本工具使用的类型`)
  } else if (node.oneOf === undefined) {
    out.push(`${path}.type 缺失`)
  }
  const properties = node.properties as Record<string, unknown> | undefined
  const required = node.required as string[] | undefined
  for (const key of required ?? []) {
    if (properties === undefined || !Object.hasOwn(properties, key)) {
      out.push(`${path}.required 里有未声明的键 ${key}`)
    }
  }
  for (const [key, child] of Object.entries(properties ?? {})) {
    out.push(...schemaViolations(child, `${path}.${key}`))
  }
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  return out
}

/** 深扫值：返回所有为 null 的路径。 */
function nullPaths(value: unknown, path = 'value'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => nullPaths(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => nullPaths(child, `${path}.${key}`))
  }
  return []
}

/** 值对 schema 的校验（本文件用到的子集：类型/enum/required/additionalProperties/items）。 */
function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  const node = schema as Record<string, unknown>
  const type = node.type as string | undefined
  const out: string[] = []
  const typeOk = (): boolean => {
    switch (type) {
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
      case 'array': return Array.isArray(value)
      case 'string': return typeof value === 'string'
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'boolean': return typeof value === 'boolean'
      default: return true
    }
  }
  if (!typeOk()) return [`${path} 类型不符（期望 ${type}）`]
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) out.push(`${path} 不在 enum`)
  if (type === 'array' && node.items !== undefined) {
    ;(value as unknown[]).forEach((item, index) => out.push(...valueViolations(node.items, item, `${path}[${index}]`)))
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>
    const properties = (node.properties ?? {}) as Record<string, unknown>
    for (const key of (node.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key)) out.push(`${path}.${key} 缺失（required）`)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} 是未声明的键`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) out.push(...valueViolations(properties[key], child, `${path}.${key}`))
    }
  }
  return out
}

const CONFIG = resolveConverterConfig({
  python_bin: PYTHON,
  converter_dir: CONVERTER_DIR,
  allowed_roots: [tmpdir()],
})
const CFG = CONFIG.resolved as NonNullable<typeof CONFIG.resolved>
const pageImage = createPageImageTool(CFG)
const merge = createModelTextMergeTool(CFG)

/** 一份"像样"的转写：长度够、无元话语、无坏字形、无包装。 */
const GOOD_READING = [
  'SYNTHETIC SAMPLE - NOT A REAL RESUME',
  'Candidate Example A',
  'Phone: 138-0000-0000   Email: demo.candidate@example.invalid',
  'Work experience',
  '2021.07 - 2024.06  Example Technology Ltd  Backend Engineer',
  '- split the order service; P99 went from 480ms to 120ms',
  'Education',
  '2015.09 - 2019.06  Example University  Computer Science  BSc',
].join('\n')

test('parameters：两个工具都是封闭对象根，page 是 1-based 整数', () => {
  for (const tool of [pageImage, merge]) {
    const parameters = tool.parameters as Record<string, unknown>
    assert.equal(parameters.type, 'object')
    assert.equal(parameters.additionalProperties, false)
    assert.deepEqual(schemaViolations(parameters), [], tool.name)
  }
  const pageImageParams = pageImage.parameters as { properties: Record<string, Record<string, unknown>> }
  assert.equal(pageImageParams.properties.page.type, 'integer')
  const mergeParams = merge.parameters as { required: string[], properties: Record<string, Record<string, unknown>> }
  assert.deepEqual(mergeParams.required, ['path', 'page', 'text'])
  assert.match(String(mergeParams.properties.text.description), /Verbatim/)
})

test('output schema：无 type 数组、无 type:null，required 都在 properties 里', () => {
  for (const tool of [pageImage, merge]) {
    assert.deepEqual(schemaViolations(tool.output.schema), [], tool.name)
    const json = JSON.stringify(tool.output.schema)
    assert.equal(json.includes('"null"'), false, `${tool.name} 的 schema 里出现了 null`)
  }
})

test('page-image 值映射：七个键齐全、无 null、能过自己的 schema', () => {
  const value = toPageImageValue({
    image_path: 'C:\\Temp\\x\\page-0001@200dpi.png',
    page: 1,
    dpi: 200,
    pixel_size: [1653, 2339],
    page_size_pt: [595.0, 842.0],
    source_sha256: 'a'.repeat(64),
    oversampled: false,
  })
  assert.deepEqual(nullPaths(value), [])
  assert.deepEqual(valueViolations(pageImage.output.schema, value), [])
  assert.deepEqual(value.pixel_size, [1653, 2339])
})

test('page-image 值映射：缺字段时退化成 0/false，但缺 image_path 直接拒', () => {
  const value = toPageImageValue({ image_path: 'C:\\Temp\\x.png' })
  assert.deepEqual(value.pixel_size, [0, 0])
  assert.deepEqual(value.page_size_pt, [0, 0])
  assert.equal(value.dpi, 0)
  assert.equal(value.oversampled, false)
  assert.deepEqual(valueViolations(pageImage.output.schema, value), [])
  assert.throws(() => toPageImageValue({}), (error: Error & { code?: string }) => error.code === 'READER_FAILED')
})

test('merge 值映射：accepted 时丢弃拒绝项，拒绝时保留 code/message', () => {
  const acceptedValue = toModelTextMergeValue({ accepted: true, rejections: [], blocks_before: 2, blocks_after: 3 })
  assert.deepEqual(acceptedValue, { accepted: true, rejections: [], blocks_before: 2, blocks_after: 3 })
  assert.deepEqual(nullPaths(acceptedValue), [])
  assert.deepEqual(valueViolations(merge.output.schema, acceptedValue), [])

  const rejectedValue = toModelTextMergeValue({
    accepted: false,
    rejections: [{ code: 'TEXT_TOO_SHORT' }, { code: 'META_DISCURSE', message: 'refusal' }, 'junk'],
    blocks_before: 0,
    blocks_after: 0,
  })
  assert.equal(rejectedValue.accepted, false)
  assert.deepEqual(rejectedValue.rejections.map((r) => r.code), ['TEXT_TOO_SHORT', 'META_DISCURSE', 'UNKNOWN'])
  for (const rejection of rejectedValue.rejections) assert.equal(typeof rejection.message, 'string')
  assert.deepEqual(valueViolations(merge.output.schema, rejectedValue), [])
})

test('merge 值映射：accepted=true 却带着拒绝项时，拒绝报告这种自相矛盾', () => {
  assert.throws(
    () => toModelTextMergeValue({ accepted: true, rejections: [{ code: 'X' }], blocks_before: 0, blocks_after: 1 }),
    (error: Error & { code?: string }) => error.code === 'READER_FAILED',
  )
})

test('routedModelId：先看本次请求的 route config，再看 agent options，都没有就是空串', () => {
  assert.equal(routedModelId({ agent: { options: { model: 'beam-free' } } }), 'beam-free')
  assert.equal(routedModelId({
    agent: { options: { model: 'fallback-model' }, session: { requestHeader: () => ({ config: { model: 'beam-free' } }) } },
  }), 'beam-free')
  assert.equal(routedModelId({ agent: { options: {} } }), '')
  assert.equal(routedModelId({}), '')
  assert.equal(routedModelId({
    agent: { session: { requestHeader: () => { throw new Error('no session') } } },
  }), '')
})

test('桥错误码映射：文件/参数/渲染失败各自落到正确的插件错误码', () => {
  const cases: Array<[string, string]> = [
    ['pdf_missing', 'NOT_FOUND'],
    ['page_out_of_range', 'INVALID_ARGS'],
    ['page_invalid', 'INVALID_ARGS'],
    ['invalid_request', 'INVALID_ARGS'],
    ['render_path_in_repo', 'FORBIDDEN'],
    ['render_failed', 'READER_FAILED'],
    ['bridge_failed', 'READER_FAILED'],
    ['something_new', 'READER_FAILED'],
  ]
  for (const [raw, expected] of cases) {
    const error = bridgeFailure({ ok: false, code: raw, message: 'x' })
    assert.equal(error.code, expected, raw)
    assert.match(error.message, new RegExp(`\\[${raw}\\]`))
  }
})

test('未配置：两个工具仍注册，调用报 NOT_CONFIGURED（不静默降级）', async () => {
  const registered: Array<{ name: string, execute: (a: unknown, e: unknown) => Promise<unknown> }> = []
  // 假 ctx 必须覆盖 apply() 真正用到的 API：
  // - `effect`：Cordis 的标准注册/清理接口，立即执行 fn 并返回 disposer。
  // - `inject`：可选依赖注入。这个假 ctx **没有 webServer**，所以回调不应被调用——
  //   正是"headless 下没有 Web 服务、插件照常工作"的真实场景。
  const ctx = {
    tools: { register: (tool: never) => registered.push(tool) },
    effect: (fn: () => unknown) => fn(),
    inject: (_names: readonly string[], _cb: (child: unknown) => void) => {},
  }
  apply(ctx as never, {}, {})
  const names = registered.map((tool) => tool.name)
  assert.ok(names.includes('recruitment_page_image'))
  assert.ok(names.includes('recruitment_model_text_merge'))
  for (const name of ['recruitment_page_image', 'recruitment_model_text_merge']) {
    const tool = registered.find((candidate) => candidate.name === name) as { execute: (a: unknown, e: unknown) => Promise<unknown> }
    await assert.rejects(
      () => tool.execute({ path: 'C:\\x.pdf', page: 1, text: 'x' }, {}),
      (error: Error & { code?: string }) => error.code === 'NOT_CONFIGURED',
    )
  }
})

test('webServer 是可选依赖，不得进顶层 inject（否则 headless 下整个插件不激活）', () => {
  // 根因守卫：顶层 inject 是硬依赖。曾把 webServer 写进去，后果是 headless/tui 等
  // 没有 Web 服务的 profile 下插件**完全不激活**，19 个工具一起消失——面板是加分项，
  // 不能成为工具存在的前提。工作台路由必须走 ctx.inject(['webServer'], …) 可选注入。
  assert.ok(!pluginInject.includes('webServer'), `顶层 inject 不得含 webServer：${pluginInject.join(', ')}`)
  assert.deepEqual([...pluginInject].sort(), ['approval', 'tools'])
})

test('未配置替身：schema 仍是封闭对象（不是 additionalProperties:true 的兜底）', () => {
  for (const tool of [unconfiguredPageImageTool(['config.python_bin is required']), unconfiguredModelTextMergeTool(['config.python_bin is required'])]) {
    const parameters = tool.parameters as Record<string, unknown>
    assert.equal(parameters.additionalProperties, false)
    assert.deepEqual(schemaViolations(parameters), [])
  }
})

test('参数校验：page 越界 / 相对路径 / 多余参数一律 INVALID_ARGS', async () => {
  const bad = [
    { path: 'C:\\x.pdf', page: 0 },
    { path: 'C:\\x.pdf', page: 1.5 },
    { path: 'relative.pdf', page: 1 },
    { path: 'C:\\x.pdf', page: 1, extra: 1 },
    {},
  ]
  for (const args of bad) {
    await assert.rejects(
      () => pageImage.execute(args, {}),
      (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
      JSON.stringify(args),
    )
  }
})

test('merge 参数校验：空 text 与超长 text 都被拒（在起子进程之前）', async () => {
  await assert.rejects(
    () => merge.execute({ path: 'C:\\x.pdf', page: 1, text: '' }, {}),
    (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
  )
  await assert.rejects(
    () => merge.execute({ path: 'C:\\x.pdf', page: 1, text: 'x'.repeat(20001) }, {}),
    (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
  )
})

test('真实 Python 路径：渲染 + 校验 + 合并，接受路径 blocks +1 且无 null', { skip: !CAN_RUN_PYTHON }, async () => {
  const pdf = makeImageOnlyPdf()
  assert.ok(existsSync(pdf))
  const rendered = await pageImage.execute({ path: pdf, page: 1 }, {}) as Record<string, unknown>
  assert.deepEqual(nullPaths(rendered), [])
  assert.deepEqual(valueViolations(pageImage.output.schema, rendered), [])
  assert.ok(existsSync(String(rendered.image_path)), '渲染出的 PNG 必须留在磁盘上给 read_image 用')
  assert.equal(rendered.page, 1)
  assert.ok(Number(rendered.dpi) >= 50)
  assert.match(String(rendered.source_sha256), /^[0-9a-f]{64}$/)

  const accepted = await merge.execute(
    { path: pdf, page: 1, text: GOOD_READING },
    { agent: { options: { model: 'beam-free' } } },
  ) as Record<string, unknown>
  assert.deepEqual(nullPaths(accepted), [])
  assert.deepEqual(valueViolations(merge.output.schema, accepted), [])
  assert.equal(accepted.accepted, true, JSON.stringify(accepted))
  assert.equal(Number(accepted.blocks_after) - Number(accepted.blocks_before), 1)
})

test('真实 Python 路径：拒绝不合并，且拒绝消息里不含原文', { skip: !CAN_RUN_PYTHON }, async () => {
  const pdf = makeImageOnlyPdf()
  const secret = 'EXAMPLE-READING-MARKER-7f3a'
  const cases: Array<[string, string]> = [
    ['TEXT_TOO_SHORT', '短'],
    ['META_DISCOURSE', '抱歉，我无法读取这张图片里的文字内容。'],
    ['PLACEHOLDER_HEAVY', '□'.repeat(40) + '示例'],
    ['OUTPUT_WRAPPED', '以下是这张简历图片的转录文字：'],
  ]
  for (const [expectedCode, text] of cases) {
    const value = await merge.execute({ path: pdf, page: 1, text }, { agent: { options: { model: 'beam-free' } } }) as Record<string, unknown>
    assert.equal(value.accepted, false, `${expectedCode}: ${JSON.stringify(value)}`)
    assert.equal(value.blocks_before, value.blocks_after, '拒绝时不得追加 block')
    const codes = (value.rejections as Array<{ code: string }>).map((rejection) => rejection.code)
    assert.ok(codes.includes(expectedCode), `${expectedCode} not in ${codes.join(',')}`)
    const serialized = JSON.stringify(value)
    assert.equal(serialized.includes(secret), false)
    assert.equal(serialized.includes(text), false, '拒绝记录不得复述原文')
  }

  // 模型 id 解析不出来时同样 fail-closed（MODEL_ID_MISSING 是硬检查）。
  const noModel = await merge.execute({ path: pdf, page: 1, text: GOOD_READING }, {}) as Record<string, unknown>
  assert.equal(noModel.accepted, false)
  assert.ok((noModel.rejections as Array<{ code: string }>).some((rejection) => rejection.code === 'MODEL_ID_MISSING'))
})

test('真实 Python 路径：page 超页数报 INVALID_ARGS，不存在文件报 NOT_FOUND', { skip: !CAN_RUN_PYTHON }, async () => {
  const pdf = makeImageOnlyPdf()
  await assert.rejects(
    () => pageImage.execute({ path: pdf, page: 9 }, {}),
    (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
  )
  await assert.rejects(
    () => merge.execute({ path: pdf, page: 9, text: GOOD_READING }, {}),
    (error: Error & { code?: string }) => error.code === 'INVALID_ARGS',
  )
  await assert.rejects(
    () => pageImage.execute({ path: join(dirname(pdf), 'missing.pdf'), page: 1 }, {}),
    (error: Error & { code?: string }) => error.code === 'NOT_FOUND',
  )
})

test('R7 自检：测试自带的合成 PDF 脚本不含真实个人资料', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.equal(source.includes('@example.invalid'), true)
  // 允许出现的人名/手机号必须是"示例"或保留号段；这里只做最小防线：
  assert.equal(/1[3-9]\d{9}/.test(source.replace(/138-0000-0000/g, '')), false, '出现了像真实手机号的串')
})
