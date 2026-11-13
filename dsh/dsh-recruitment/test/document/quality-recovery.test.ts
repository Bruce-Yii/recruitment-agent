// U2 恢复计划的独立测试：分派条件、视觉补读页清单与渲染参数、模型不支持图像时的 BLOCKED。
//
// 边界：这些测试证明「计划正确」，不证明「模型真的读到了」。真正的视觉补读由 U3
// 在 DSH Agent 里经 recruitment_page_image + read_image 触发（D-81）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { assess } from '../../src/document/quality/index.ts'
import { plan } from '../../src/document/recovery/index.ts'

type Block = {
  block_id: string
  kind: string
  order: number
  text: string
  locator: Record<string, unknown>
  provenance: string
  links?: Array<{ text: string, href: string }>
}

function makeContent(blocks: Block[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    asset_sha256: 'b'.repeat(64),
    media_type: 'application/pdf',
    reader_id: 'pdf:pymupdf-mounted/1.28.0',
    reader_version: '1.28.0',
    text: blocks.map((block) => block.text).join('\n\n'),
    blocks,
    completeness: 'complete',
    needs_visual: false,
    issues: [],
    meta: { pages: 1, order_verified: true, backend: 'pymupdf+layout/1.28.0' },
    ...overrides,
  }
}

function goodBlocks(): Block[] {
  return [
    { block_id: 'b1', kind: 'paragraph', order: 1, text: '张三', locator: { kind: 'pdf', page: 1, bbox: [50, 60, 120, 80] }, provenance: 'native_text' },
    { block_id: 'b2', kind: 'paragraph', order: 2, text: 'Example Technology Ltd 2021.07 - 2024.06 后端工程师', locator: { kind: 'pdf', page: 1, bbox: [50, 160, 400, 180] }, provenance: 'native_text' },
  ]
}

const scannedPdf = (): Record<string, unknown> => ({
  schema_version: '1',
  asset_sha256: 'c'.repeat(64),
  media_type: 'application/pdf',
  reader_id: 'pdf:pymupdf-mounted/1.28.0',
  text: '',
  blocks: [],
  completeness: 'partial',
  needs_visual: true,
  issues: [{ code: 'pdf_no_text', message: 'PDF has no machine-readable text' }],
  meta: { pages: 3, order_verified: false, backend: 'pymupdf/1.28.0' },
})

test('合格内容：不出计划，next=structure，requires_model=false', () => {
  const recovery = plan(makeContent(goodBlocks()))
  assert.equal(recovery.blocking, false)
  assert.equal(recovery.next, 'structure')
  assert.equal(recovery.requires_model, false)
  assert.deepEqual(recovery.steps, [])
  assert.deepEqual(recovery.vision, [])
  assert.equal(recovery.summary.total, 0)
  assert.equal(recovery.assessment.completeness, 'complete')
})

test('扫描件（pdf_no_text，3 页）：生成 3 页视觉补读计划 + 渲染参数，不调模型', () => {
  const recovery = plan(scannedPdf())
  assert.equal(recovery.blocking, true)
  assert.equal(recovery.next, 'repair')
  assert.equal(recovery.requires_model, true)
  assert.equal(recovery.model_image_support, 'assumed')
  const step = recovery.steps.find((item) => item.action === 'vision_read')
  assert.ok(step !== undefined, '必须有 vision_read 步')
  assert.equal(step?.role, 'agent')
  assert.equal(step?.blocking, true)
  assert.equal(step?.status, 'planned')
  assert.deepEqual(step?.vision.map((request) => request.page), [1, 2, 3])
  const request = step?.vision[0]
  assert.equal(request?.kind, 'pdf_page')
  assert.equal(request?.render?.tool, 'recruitment_page_image')
  assert.equal(request?.render?.dpi, 200)
  assert.equal(request?.render?.format, 'png')
  assert.equal(request?.render?.page_1_based, true)
  assert.equal(request?.render?.consumer, 'read_image')
  assert.deepEqual(request?.render?.args, { page: 1 })
  assert.equal(request?.read_with, 'read_image')
  assert.equal(request?.model_needed, true)
  assert.deepEqual(recovery.summary.vision_pages, [1, 2, 3])
  assert.ok(recovery.notes.some((note) => note.includes('D-81')))
  assert.ok(recovery.notes.some((note) => note.includes('不调用模型')))
  // 计划里不放绝对路径（R7）：只给页号，path 由调用方提供
  assert.equal(JSON.stringify(recovery).includes('C:\\\\'), false)
})

test('模型不支持图像：vision 步 BLOCKED，并降级出工程人工步（不得谎称视觉读取成功）', () => {
  const recovery = plan(scannedPdf(), { model_supports_image: false })
  assert.equal(recovery.model_image_support, 'unsupported')
  const vision = recovery.steps.find((item) => item.action === 'vision_read')
  assert.equal(vision?.status, 'blocked')
  assert.equal(vision?.blocked_reason, 'MODEL_HAS_NO_IMAGE_SUPPORT')
  const fallback = recovery.steps.find((item) => item.action === 'human_review' && item.fallback_from === 'vision_read')
  assert.ok(fallback !== undefined, '必须有 vision_read 的降级人工步')
  assert.equal(fallback?.role, 'engineering')
  assert.equal(fallback?.blocking, true)
  assert.match(fallback?.problem ?? '', /不支持图像/u)
  assert.ok(recovery.notes.some((note) => note.includes('G2')))
  assert.equal(recovery.blocking, true)
})

test('单次补读页数有上限：超出部分转人工，且明确标出页号', () => {
  const recovery = plan(scannedPdf(), { max_vision_pages: 2 })
  assert.deepEqual(recovery.summary.vision_pages, [1, 2])
  const overflow = recovery.steps.find((item) => item.action === 'human_review' && item.fallback_from === 'vision_read')
  assert.ok(overflow !== undefined)
  assert.equal(overflow?.role, 'recruiter')
  assert.equal(overflow?.blocking, true)
  assert.match(overflow?.problem ?? '', /第 3 页/u)
})

test('DOCX 没有页可补读：vision_read 降级成 switch_reader（docx 能力候选）', () => {
  const content = makeContent([
    { block_id: 'p1', kind: 'paragraph', order: 1, text: '张三', locator: { kind: 'docx', part: 'word/document.xml', paragraph_id: 'p1' }, provenance: 'docling' },
  ], {
    media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    reader_id: 'docx:docling',
    issues: [{ code: 'visual_read_required', message: 'material has unread visual content' }],
    completeness: 'partial',
    meta: { order_verified: true },
  })
  const recovery = plan(content)
  assert.equal(recovery.requires_model, false)
  const switched = recovery.steps.find((item) => item.action === 'switch_reader')
  assert.ok(switched !== undefined, 'DOCX 不能补读页，必须换读取能力')
  assert.equal(switched?.fallback_from, 'vision_read')
  assert.equal(switched?.role, 'reader_service')
  assert.ok((switched?.switch_reader?.candidates ?? []).every((candidate) => candidate.startsWith('docx:')),
    `候选必须是 docx 能力：${JSON.stringify(switched?.switch_reader?.candidates)}`)
  assert.equal(switched?.vision.length, 0)
})

test('图像媒体：补读是 read_image 原图（无页渲染），不伪造 page', () => {
  const content = makeContent([
    { block_id: 'i1', kind: 'paragraph', order: 1, text: 'RESUME IMAGE', locator: { kind: 'image', frame: 0 }, provenance: 'ocr' },
  ], {
    media_type: 'image/png',
    reader_id: 'image:ocr',
    issues: [{ code: 'unread_visual_page', message: 'low-text page contains graphics', locator: { kind: 'image', frame: 0 } }],
    completeness: 'partial',
    meta: { order_verified: true },
  })
  const recovery = plan(content)
  const vision = recovery.steps.find((item) => item.action === 'vision_read')
  assert.ok(vision !== undefined)
  const request = vision?.vision[0]
  assert.equal(request?.kind, 'image_frame')
  assert.equal(request?.page, null)
  assert.equal(request?.frame, 0)
  assert.equal(request?.render, null)
  assert.equal(request?.read_with, 'read_image')
  // OCR 来源未核 → 同时有 recruiter 人工复核步
  assert.ok(recovery.steps.some((item) => item.action === 'human_review' && item.role === 'recruiter'))
})

test('retry：可重试问题给有限预算（默认 1 次），用尽落到 human_review', () => {
  const content = makeContent(goodBlocks(), {
    completeness: 'partial',
    issues: [{ code: 'reader_timeout', message: 'reader timed out' }],
    meta: { pages: 1, order_verified: true },
  })
  const recovery = plan(content)
  const retry = recovery.steps.find((item) => item.action === 'retry')
  assert.ok(retry !== undefined)
  assert.equal(retry?.role, 'reader_service')
  assert.equal(retry?.retry?.max_attempts, 1)
  assert.deepEqual(retry?.retry?.backoff_ms, [500])
  assert.equal(retry?.retry?.on_exhausted, 'human_review')
  assert.equal(retry?.blocking, true)
})

test('retry：预算为 0 时直接换读取器（fallback_from=retry），不无限重试', () => {
  const content = makeContent(goodBlocks(), {
    completeness: 'partial',
    issues: [{ code: 'reader_timeout', message: 'reader timed out' }],
    meta: { pages: 1, order_verified: true },
  })
  const recovery = plan(content, { max_retries: 0 })
  assert.equal(recovery.steps.some((item) => item.action === 'retry'), false)
  const switched = recovery.steps.find((item) => item.action === 'switch_reader')
  assert.equal(switched?.fallback_from, 'retry')
  assert.ok((switched?.switch_reader?.candidates ?? []).length > 0)
  assert.equal(switched?.switch_reader?.from, 'pdf:pymupdf-mounted/1.28.0')
})

test('human_review 分派：未登记 code → 工程；跨块错配/加密 → 招聘同学', () => {
  const unknown = plan(makeContent(goodBlocks(), {
    completeness: 'partial',
    issues: [{ code: 'future_code_x', message: 'x' }],
  }))
  const engineering = unknown.steps.find((item) => item.codes.includes('future_code_x'))
  assert.equal(engineering?.role, 'engineering')
  assert.equal(engineering?.blocking, true)
  assert.deepEqual(engineering?.human?.options, ['confirm', 'amend', 'still_unreadable'])
  assert.equal(engineering?.human?.resume_from, 'quality_gate')

  const crossBlock = plan(makeContent([
    { block_id: 'a', kind: 'paragraph', order: 1, text: 'Example Technology Ltd', locator: { kind: 'pdf', page: 1, bbox: [300, 160, 480, 178] }, provenance: 'native_text' },
    { block_id: 'b', kind: 'paragraph', order: 2, text: '2021.07 - 2024.06 后端工程师', locator: { kind: 'pdf', page: 1, bbox: [50, 200, 280, 218] }, provenance: 'native_text' },
  ]))
  const recruiter = crossBlock.steps.find((item) => item.codes.includes('doc_cross_block_attribution'))
  assert.equal(recruiter?.role, 'recruiter')
  assert.equal(recruiter?.action, 'human_review')
  assert.equal(recruiter?.locators.length, 2, '必须给出两个区块的定位')
  assert.equal(crossBlock.next, 'human')

  const encrypted = plan({
    schema_version: '1',
    media_type: 'application/pdf',
    reader_id: 'pdf:pymupdf-mounted/1.28.0',
    text: '',
    blocks: [],
    completeness: 'partial',
    issues: [{ code: 'encrypted_pdf', message: 'PDF cannot be opened without a password' }],
    meta: { pages: 2, order_verified: false },
  })
  const password = encrypted.steps.find((item) => item.codes.includes('encrypted_pdf'))
  assert.equal(password?.role, 'recruiter')
  assert.equal(password?.blocking, true)
})

test('每个计划项都带：具体问题、原文定位、建议动作、责任角色', () => {
  const recovery = plan(makeContent(goodBlocks(), {
    meta: { pages: 3, order_verified: false },
    completeness: 'partial',
  }))
  assert.ok(recovery.steps.length > 0)
  const roles = new Set(['reader_service', 'agent', 'recruiter', 'engineering'])
  const actions = new Set(['retry', 'switch_reader', 'vision_read', 'human_review', 'none'])
  for (const step of recovery.steps) {
    assert.ok(step.problem.length > 10, `${step.step_id}: problem 太短`)
    assert.ok(Array.isArray(step.locators), `${step.step_id}: locators 必须是数组`)
    assert.ok(roles.has(step.role), `${step.step_id}: role=${step.role}`)
    assert.ok(actions.has(step.action), `${step.step_id}: action=${step.action}`)
    assert.equal(typeof step.blocking, 'boolean')
    assert.ok(step.codes.length > 0, `${step.step_id}: 没有 code`)
    assert.match(step.problem, /原文定位/u, `${step.step_id}: 没写原文定位`)
  }
  const ids = recovery.steps.map((step) => step.step_id)
  assert.equal(ids.length, new Set(ids).size, 'step_id 必须唯一')
  assert.equal(recovery.summary.total, recovery.steps.length)
})

test('计划是纯数据：可 JSON 往返（无 undefined），且同输入两次一致', () => {
  const content = scannedPdf()
  const first = plan(content)
  const second = plan(content)
  assert.deepEqual(first, second)
  assert.equal(first.plan_id, second.plan_id)
  assert.match(first.plan_id, /^plan-[0-9a-f]{8}$/u)
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(first)))
  assert.equal(JSON.stringify(first).includes('undefined'), false)
})

test('计划复用外部判定：传 assessment 时不重新判定（结果一致）', () => {
  const content = scannedPdf()
  const assessment = assess(content)
  const recovery = plan(content, { assessment })
  assert.equal(recovery.assessment, assessment)
  assert.equal(recovery.blocking, assessment.blocking)
})

test('垃圾输入也 fail-closed：给工程人工步，不给「已合格」', () => {
  const recovery = plan(null)
  assert.equal(recovery.blocking, true)
  assert.notEqual(recovery.next, 'structure')
  const step = recovery.steps[0]
  assert.equal(step.action, 'human_review')
  assert.equal(step.role, 'engineering')
  assert.equal(step.blocking, true)
  assert.ok(recovery.notes.some((note) => note.includes('未登记') || note.includes('未做 URI 对照')) ||
    recovery.assessment.blocking_codes.includes('doc_contract_invalid'))
})

test('reader facts 可透传：canonical 契约缺页数/顺序声明时也能出「合格」计划', () => {
  const canonical = {
    schema_version: '1.0.0',
    asset_sha256: 'e'.repeat(64),
    media_type: 'application/pdf',
    reader_id: 'pdf:pymupdf-mounted/1.28.0',
    reader_version: '1.28.0',
    text: '张三\n\nExample Technology Ltd 2021.07 - 2024.06 后端工程师',
    blocks: goodBlocks().map((block) => ({ ...block })),
    completeness: 'complete',
    needs_visual: false,
    issues: [],
    elapsed_ms: 8,
  }
  const bare = plan(canonical)
  assert.equal(bare.blocking, true, '没有 facts 不得判合格')
  const withFacts = plan(canonical, { facts: { page_count: 1, order_verified: true } })
  assert.equal(withFacts.blocking, false)
  assert.equal(withFacts.next, 'structure')
  assert.deepEqual(withFacts.steps, [])
})

test('没有 URI 对照清单时，计划必须说明「未对照」，不能当成没问题', () => {
  const recovery = plan(makeContent(goodBlocks()))
  assert.equal(recovery.assessment.facts.uri_verified, false)
  // 合格内容没有 issue，不会生成计划步；但说明仍然随计划出发
  const blockedPlan = plan(makeContent(goodBlocks(), {
    completeness: 'partial',
    issues: [{ code: 'reader_timeout', message: 'timeout' }],
  }))
  assert.ok(blockedPlan.notes.some((note) => note.includes('未做 URI 对照')))
})
