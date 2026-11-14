// DocumentContent 校验器的正例 / 负例（纯函数，不起子进程，也不读文件）。
//
// 一个契约如果没有可执行的反例，它就只是一段 Markdown。这里的每个用例都对应
// docs/19 §2.1 的一条约束或 §2.2 的一条红线：
//   * 缺字段 / 表外键   → 契约的封闭键集（additionalProperties: false 的等价物）；
//   * locator 非法      → 「证据必须能指回原件哪里」，不许 0 页、不许半截 bbox；
//   * provenance 越界   → OCR 文字不许冒充 native_text 的枚举面；
//   * issue severity    → 大写 HARD / SOFT（前端/下游按字面比较）；
//   * complete 自相矛盾 → §5 NO-GO「失败静默变 complete」的机械拦截。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatViolations,
  isDocumentContent,
  validateDocumentContent,
  type DocumentContentValidation,
} from '../../src/document/contracts/validate.ts'

/** 一份合法的 PDF 内容（后面所有负例都从它派生，保证「只错一处」）。 */
function validPdfContent(): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    asset_sha256: 'a'.repeat(64),
    media_type: 'application/pdf',
    reader_id: 'pymupdf/1.28.0',
    reader_version: '1.0.0',
    reader_profile: 'layout-v1',
    text: 'SYNTHETIC FIRST LINE\n\nSYNTHETIC SECOND LINE',
    blocks: [
      {
        block_id: 'b1',
        kind: 'paragraph',
        text: 'SYNTHETIC FIRST LINE',
        order: 0,
        locator: { kind: 'pdf', page: 1, bbox: [72, 87, 330, 103], block_id: '0' },
        provenance: 'native_text',
      },
      {
        block_id: 'b2',
        kind: 'link',
        text: 'SYNTHETIC SECOND LINE',
        order: 1,
        locator: { kind: 'pdf', page: 2 },
        links: [{ text: 'example link', href: 'https://example.invalid/sample' }],
        provenance: 'native_text',
      },
      {
        block_id: 'b3',
        kind: 'heading',
        text: 'SYNTHETIC HEADING',
        order: 2,
        locator: { kind: 'pdf', page: 2, bbox: [72, 120, 200, 140] },
        provenance: 'ocr',
      },
    ],
    completeness: 'partial',
    needs_visual: false,
    issues: [
      {
        code: 'pdf_page_empty',
        message: 'page 3 has no text, no image and no drawing',
        locator: { kind: 'pdf', page: 3 },
        severity: 'SOFT',
        retryable: false,
        suggested_action: 'none',
      },
    ],
    elapsed_ms: 12,
  }
}

/** 派生一个只改了一处的副本。 */
function withPatch(patch: (copy: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = structuredClone(validPdfContent())
  patch(copy)
  return copy
}

/** 取出全部违反项 code。 */
function codesOf(validation: DocumentContentValidation): string[] {
  return validation.violations.map((violation) => violation.code)
}

/** 断言：不合法，且报了期望的 code（可多个）。 */
function expectViolation(content: unknown, ...expected: string[]): DocumentContentValidation {
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, false, `expected invalid, got valid (${formatViolations(validation)})`)
  for (const code of expected) {
    assert.ok(
      codesOf(validation).includes(code),
      `expected violation ${code}, got [${codesOf(validation).join(', ')}]\n${formatViolations(validation)}`,
    )
  }
  return validation
}

/** 取第一个块（负例里用来改单块）。 */
function blockAt(content: Record<string, unknown>, index: number): Record<string, unknown> {
  return (content.blocks as Record<string, unknown>[])[index] as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 正例
// ---------------------------------------------------------------------------

test('P1 合法 PDF 内容通过：三块、两种 locator、一条 SOFT issue', () => {
  const validation = validateDocumentContent(validPdfContent())
  assert.deepEqual(validation.violations, [])
  assert.equal(validation.valid, true)
  assert.deepEqual(validation.stats, {
    blocks: 3,
    links: 1,
    issues: 1,
    hard_issues: 0,
    soft_issues: 1,
    violations_hard: 0,
    violations_soft: 0,
    media_type: 'application/pdf',
  })
})

test('P2 空文档是合法的：0 块 0 issue（读完是空 ≠ 读失败）', () => {
  const content = withPatch((copy) => {
    copy.text = ''
    copy.blocks = []
    copy.issues = []
    copy.completeness = 'complete'
  })
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, true)
  assert.equal(validation.stats.blocks, 0)
})

test('P3 DOCX 内容合法且**不需要 page+bbox**：只给 part + paragraph_id', () => {
  const content = withPatch((copy) => {
    copy.media_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    copy.reader_id = 'python-docx/1.1.2'
    copy.blocks = [
      {
        block_id: 'p1',
        kind: 'paragraph',
        text: 'SYNTHETIC DOCX PARAGRAPH',
        order: 0,
        locator: { kind: 'docx', part: 'word/document.xml', paragraph_id: 'p2' },
        provenance: 'native_text',
      },
      {
        block_id: 't1',
        kind: 'table',
        text: 'YEAR | ROLE',
        order: 1,
        locator: { kind: 'docx', part: 'word/document.xml', table_id: 't1', row: 0, cell: 0 },
        provenance: 'native_text',
      },
    ]
  })
  const validation = validateDocumentContent(content)
  assert.deepEqual(validation.violations, [], formatViolations(validation))
  assert.equal(validation.valid, true)
})

test('P4 图片内容合法且**不需要 page+bbox**：一个 frame 就够', () => {
  const content = withPatch((copy) => {
    copy.media_type = 'image/png'
    copy.reader_id = 'pillow/12.3.0'
    copy.blocks = [
      {
        block_id: 'i1',
        kind: 'paragraph',
        text: 'SCANNED LINE',
        order: 0,
        locator: { kind: 'image', frame: 0, bbox: [0, 0, 100, 40] },
        provenance: 'ocr',
      },
      {
        block_id: 'i2',
        kind: 'other',
        text: 'UNLOCATED LINE',
        order: 1,
        locator: { kind: 'image' },
        provenance: 'agent_read',
      },
    ]
  })
  const validation = validateDocumentContent(content)
  assert.deepEqual(validation.violations, [], formatViolations(validation))
  assert.equal(validation.valid, true)
})

test('P5 空块文本只记 soft，不影响 valid（空块可疑但不是非法）', () => {
  const content = withPatch((copy) => {
    blockAt(copy, 0).text = '   '
  })
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, true)
  assert.ok(codesOf(validation).includes('BLOCK_TEXT_EMPTY'))
  assert.equal(validation.violations[0]?.severity, 'soft')
})

// ---------------------------------------------------------------------------
// 负例：缺字段 / 表外键 / 枚举越界
// ---------------------------------------------------------------------------

test('N1 缺顶层字段：逐个 MISSING_FIELD，且一次报全（不是遇错就停）', () => {
  const content = withPatch((copy) => {
    for (const key of ['schema_version', 'asset_sha256', 'reader_id', 'reader_version', 'text', 'blocks', 'completeness', 'needs_visual', 'issues', 'elapsed_ms']) {
      delete copy[key]
    }
  })
  const validation = expectViolation(content, 'MISSING_FIELD')
  const paths = validation.violations.filter((v) => v.code === 'MISSING_FIELD').map((v) => v.path)
  for (const key of ['schema_version', 'asset_sha256', 'reader_id', 'reader_version', 'text', 'blocks', 'completeness', 'needs_visual', 'issues', 'elapsed_ms']) {
    assert.ok(paths.includes(key), `missing MISSING_FIELD for ${key}, got ${paths.join(', ')}`)
  }
})

test('N2 表外键一律拒绝（契约是封闭键集，不静默忽略）', () => {
  expectViolation(withPatch((copy) => { copy.markdown = '# hi' }), 'UNEXPECTED_KEY')
  expectViolation(withPatch((copy) => { blockAt(copy, 0).page = 1 }), 'UNEXPECTED_KEY')
  expectViolation(
    withPatch((copy) => { blockAt(copy, 0).locator = { kind: 'pdf', page: 1, para: 3 } }),
    'UNEXPECTED_KEY',
  )
})

test('N3 schema_version 不认识就不猜结构', () => {
  expectViolation(withPatch((copy) => { copy.schema_version = '9.9.9' }), 'SCHEMA_VERSION_UNSUPPORTED')
  expectViolation(withPatch((copy) => { copy.schema_version = '' }), 'INVALID_FIELD')
})

test('N4 asset_sha256 必须是 64 位 hex（结构化引用要能指回原件）', () => {
  expectViolation(withPatch((copy) => { copy.asset_sha256 = 'abc' }), 'ASSET_SHA_INVALID')
  expectViolation(withPatch((copy) => { copy.asset_sha256 = 'z'.repeat(64) }), 'ASSET_SHA_INVALID')
  expectViolation(withPatch((copy) => { delete copy.asset_sha256 }), 'MISSING_FIELD')
})

test('N5 media_type 是封闭集合', () => {
  expectViolation(withPatch((copy) => { copy.media_type = 'text/plain' }), 'MEDIA_TYPE_UNSUPPORTED')
})

test('N6 completeness 三态；needs_visual 必须布尔；elapsed_ms 非负', () => {
  expectViolation(withPatch((copy) => { copy.completeness = 'full' }), 'COMPLETENESS_INVALID')
  expectViolation(withPatch((copy) => { copy.needs_visual = 'true' }), 'NEEDS_VISUAL_INVALID')
  expectViolation(withPatch((copy) => { copy.elapsed_ms = -1 }), 'ELAPSED_INVALID')
  expectViolation(withPatch((copy) => { copy.elapsed_ms = Number.POSITIVE_INFINITY }), 'ELAPSED_INVALID')
})

// ---------------------------------------------------------------------------
// 负例：locator
// ---------------------------------------------------------------------------

test('N7 locator 缺失 / 页码 0 / 页码负数都是非法证据（不许伪造页）', () => {
  expectViolation(withPatch((copy) => { delete blockAt(copy, 0).locator }), 'LOCATOR_MISSING')
  expectViolation(
    withPatch((copy) => { blockAt(copy, 0).locator = { kind: 'pdf', page: 0 } }),
    'LOCATOR_INVALID',
  )
  expectViolation(
    withPatch((copy) => { blockAt(copy, 0).locator = { kind: 'pdf', page: -2 } }),
    'LOCATOR_INVALID',
  )
})

test('N8 bbox 必须是恰好 4 个有限数且不反转', () => {
  expectViolation(
    withPatch((copy) => { blockAt(copy, 0).locator = { kind: 'pdf', page: 1, bbox: [1, 2, 3] } }),
    'LOCATOR_INVALID',
  )
  expectViolation(
    withPatch((copy) => { blockAt(copy, 0).locator = { kind: 'pdf', page: 1, bbox: [10, 90, 5, 20] } }),
    'LOCATOR_INVALID',
  )
  expectViolation(
    withPatch((copy) => { blockAt(copy, 0).locator = { kind: 'pdf', page: 1, bbox: [1, 2, '3', 4] } }),
    'LOCATOR_INVALID',
  )
})

test('N9 DOCX 单元格不能没有表：row/cell 必须带 table_id', () => {
  expectViolation(
    withPatch((copy) => {
      blockAt(copy, 0).locator = { kind: 'docx', part: 'word/document.xml', row: 2, cell: 1 }
    }),
    'LOCATOR_INVALID',
  )
})

test('N10 locator 的 kind 必须和 media_type 一致（证据不能指错类型）', () => {
  expectViolation(
    withPatch((copy) => { blockAt(copy, 0).locator = { kind: 'image', frame: 0 } }),
    'LOCATOR_MEDIA_MISMATCH',
  )
  expectViolation(
    withPatch((copy) => { blockAt(copy, 0).locator = { kind: 'docx', part: 'word/document.xml' } }),
    'LOCATOR_MEDIA_MISMATCH',
  )
})

test('N11 链接的目标定位也要合法', () => {
  expectViolation(
    withPatch((copy) => {
      blockAt(copy, 1).links = [{ text: 'x', href: 'https://example.invalid', locator: { kind: 'pdf', page: 0 } }]
    }),
    'LINK_LOCATOR_INVALID',
  )
  expectViolation(
    withPatch((copy) => { blockAt(copy, 1).links = [{ text: 'x' }] }),
    'LINK_INVALID',
  )
})

// ---------------------------------------------------------------------------
// 负例：provenance / block 身份 / issue 枚举
// ---------------------------------------------------------------------------

test('N12 provenance 越界（OCR 文字不许标成集合外的值）', () => {
  expectViolation(withPatch((copy) => { blockAt(copy, 0).provenance = 'ocr_sim' }), 'PROVENANCE_INVALID')
  expectViolation(withPatch((copy) => { delete blockAt(copy, 0).provenance }), 'PROVENANCE_INVALID')
  expectViolation(withPatch((copy) => { blockAt(copy, 0).provenance = 'Native_Text' }), 'PROVENANCE_INVALID')
})

test('N13 block_id 必须唯一且非空（下游只能引用 id，不能引用下标）', () => {
  expectViolation(withPatch((copy) => { blockAt(copy, 1).block_id = 'b1' }), 'BLOCK_ID_DUPLICATED')
  expectViolation(withPatch((copy) => { blockAt(copy, 0).block_id = '' }), 'BLOCK_ID_INVALID')
})

test('N14 block.kind 是封闭集合', () => {
  expectViolation(withPatch((copy) => { blockAt(copy, 0).kind = 'photo' }), 'BLOCK_KIND_INVALID')
})

test('N15 order 必须是唯一、严格递增的非负整数', () => {
  expectViolation(withPatch((copy) => { blockAt(copy, 1).order = 0 }), 'BLOCK_ORDER_DUPLICATED')
  expectViolation(withPatch((copy) => { blockAt(copy, 1).order = -1 }), 'BLOCK_ORDER_INVALID')
  expectViolation(
    withPatch((copy) => {
      blockAt(copy, 0).order = 2
      blockAt(copy, 1).order = 1
      blockAt(copy, 2).order = 0
    }),
    'BLOCK_ORDER_NOT_ASCENDING',
  )
})

test('N16 issue severity 非法（大写是硬约束，小写/其它枚举都拒）', () => {
  for (const severity of ['hard', 'soft', 'ERROR', '', 1]) {
    expectViolation(
      withPatch((copy) => {
        ;(copy.issues as Record<string, unknown>[])[0]!.severity = severity
      }),
      'ISSUE_SEVERITY_INVALID',
    )
  }
})

test('N17 issue 的 retryable / suggested_action / code / message', () => {
  expectViolation(
    withPatch((copy) => {
      ;(copy.issues as Record<string, unknown>[])[0]!.retryable = 'yes'
    }),
    'ISSUE_RETRYABLE_INVALID',
  )
  expectViolation(
    withPatch((copy) => {
      ;(copy.issues as Record<string, unknown>[])[0]!.suggested_action = 'ocr'
    }),
    'ISSUE_ACTION_INVALID',
  )
  expectViolation(
    withPatch((copy) => {
      ;(copy.issues as Record<string, unknown>[])[0]!.code = ''
    }),
    'ISSUE_CODE_INVALID',
  )
  expectViolation(
    withPatch((copy) => {
      ;(copy.issues as Record<string, unknown>[])[0]!.message = '  '
    }),
    'ISSUE_MESSAGE_INVALID',
  )
})

// ---------------------------------------------------------------------------
// 负例：跨字段红线（docs/19 §5 NO-GO）
// ---------------------------------------------------------------------------

test('N18 complete 不得与 HARD issue 并存（失败不许静默变 complete）', () => {
  const content = withPatch((copy) => {
    copy.completeness = 'complete'
    ;(copy.issues as Record<string, unknown>[])[0]!.severity = 'HARD'
  })
  expectViolation(content, 'COMPLETENESS_CONTRADICTS_ISSUES')
})

test('N19 complete 不得与 needs_visual 并存', () => {
  expectViolation(
    withPatch((copy) => {
      copy.completeness = 'complete'
      copy.needs_visual = true
    }),
    'COMPLETENESS_CONTRADICTS_VISUAL',
  )
})

test('N20 同样的内容，只要不改声明就合法（红线只在自相矛盾时触发）', () => {
  // 把 complete 改成 partial，其余不动：HARD issue + needs_visual 都可以合法存在。
  const validation = validateDocumentContent(
    withPatch((copy) => {
      copy.completeness = 'partial'
      copy.needs_visual = true
      ;(copy.issues as Record<string, unknown>[])[0]!.severity = 'HARD'
    }),
  )
  assert.equal(validation.valid, true, formatViolations(validation))
})

// ---------------------------------------------------------------------------
// 健壮性：永不抛异常
// ---------------------------------------------------------------------------

test('N21 输入是垃圾也不抛异常（校验器只收集，不崩）', () => {
  const garbage: unknown[] = [undefined, null, 0, 42, 'content', [], [validPdfContent()], true, { blocks: 'x' }]
  for (const value of garbage) {
    const validation = validateDocumentContent(value)
    assert.equal(validation.valid, false, `expected invalid for ${JSON.stringify(value) ?? 'undefined'}`)
    assert.ok(validation.violations.length > 0)
  }
  assert.equal(validateDocumentContent(null).violations[0]?.code, 'ROOT_NOT_OBJECT')
})

test('N22 一次输入里的多处错误全部被收集（不是首错即停）', () => {
  const content = withPatch((copy) => {
    copy.media_type = 'text/html'
    copy.asset_sha256 = 'nope'
    blockAt(copy, 0).provenance = 'guessed'
    ;(copy.issues as Record<string, unknown>[])[0]!.severity = 'warn'
  })
  const validation = validateDocumentContent(content)
  for (const code of ['MEDIA_TYPE_UNSUPPORTED', 'ASSET_SHA_INVALID', 'PROVENANCE_INVALID', 'ISSUE_SEVERITY_INVALID']) {
    assert.ok(codesOf(validation).includes(code), `expected ${code}, got ${codesOf(validation).join(', ')}`)
  }
  assert.ok(validation.stats.violations_hard >= 4)
})

test('N23 辅助函数：isDocumentContent 窄化 + formatViolations 可读', () => {
  assert.equal(isDocumentContent(validPdfContent()), true)
  assert.equal(isDocumentContent({ blocks: [] }), false)
  const validation = expectViolation(withPatch((copy) => { copy.asset_sha256 = 'x' }), 'ASSET_SHA_INVALID')
  const text = formatViolations(validation)
  assert.match(text, /HARD ASSET_SHA_INVALID asset_sha256:/)
  assert.equal(formatViolations(validateDocumentContent(validPdfContent())), 'ok: no violations')
})

// ---------------------------------------------------------------------------
// RTF（2026-11-14 新增的第五种媒体）：定位是 paragraph（+ 可选 page），没有 bbox
// ---------------------------------------------------------------------------

/** 一份合法的 RTF 内容：段落序号定位；没有 bbox。 */
function validRtfContent(): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    asset_sha256: 'b'.repeat(64),
    media_type: 'application/rtf',
    reader_id: 'striprtf/0.0.35',
    reader_version: '1.0.0',
    text: 'SYNTHETIC RTF LINE ONE\n\nSYNTHETIC RTF LINE TWO',
    blocks: [
      {
        block_id: 'b1',
        kind: 'paragraph',
        text: 'SYNTHETIC RTF LINE ONE',
        order: 0,
        locator: { kind: 'rtf', paragraph: 0, page: 1 },
        provenance: 'native_text',
      },
      {
        block_id: 'b2',
        kind: 'paragraph',
        text: 'SYNTHETIC RTF LINE TWO',
        order: 1,
        // 有硬分页符的文件：读取器不重建逐页归属 → 只给段落序号（不编页码）。
        locator: { kind: 'rtf', paragraph: 1 },
        provenance: 'native_text',
      },
    ],
    completeness: 'partial',
    needs_visual: false,
    issues: [
      {
        code: 'unverified_rtf_embedded_image',
        message: 'RTF embeds 1 image(s); images are not read by this text reader',
        locator: { kind: 'rtf', page: 1 },
        severity: 'HARD',
        retryable: false,
        suggested_action: 'human_review',
      },
    ],
    elapsed_ms: 5,
  }
}

test('R1 合法 RTF 内容通过：段落序号定位 + 可选逻辑页 + 无 bbox', () => {
  const validation = validateDocumentContent(validRtfContent())
  assert.deepEqual(validation.violations, [], formatViolations(validation))
  assert.equal(validation.valid, true)
  assert.equal(validation.stats.media_type, 'application/rtf')
})

test('R2 RTF 的 media_type 与 locator kind 必须一致（pdf 定位长在 RTF 上 = 证据指错类型）', () => {
  const content = structuredClone(validRtfContent())
  ;(content.blocks as Record<string, unknown>[])[0]!.locator = { kind: 'pdf', page: 1 }
  expectViolation(content, 'LOCATOR_MEDIA_MISMATCH')
})

test('R3 RTF 定位不带 bbox；paragraph / page 至少一个（都没有 = 没有证据）', () => {
  // 带 bbox：表外键 → 非法（RTF 没有 PDF 用户空间坐标）。
  expectViolation(
    withRtfPatch((copy) => {
      blockAt(copy, 0).locator = { kind: 'rtf', paragraph: 0, bbox: [1, 2, 3, 4] }
    }),
    'UNEXPECTED_KEY',
  )
  // 两个都不给：等于没有定位，不能"看起来没问题"。
  expectViolation(
    withRtfPatch((copy) => {
      blockAt(copy, 0).locator = { kind: 'rtf' }
    }),
    'LOCATOR_INVALID',
  )
  // paragraph 非法（负数 / 非整数）。
  expectViolation(
    withRtfPatch((copy) => {
      blockAt(copy, 0).locator = { kind: 'rtf', paragraph: -1 }
    }),
    'LOCATOR_INVALID',
  )
  expectViolation(
    withRtfPatch((copy) => {
      blockAt(copy, 0).locator = { kind: 'rtf', paragraph: 1.5 }
    }),
    'LOCATOR_INVALID',
  )
  // page 0 是"读取器没报页码"的哨兵：宁可判非法，也不编一个真实页。
  expectViolation(
    withRtfPatch((copy) => {
      blockAt(copy, 0).locator = { kind: 'rtf', paragraph: 0, page: 0 }
    }),
    'LOCATOR_INVALID',
  )
})

test('R4 issue 的 RTF 定位可以只有 page（问题指向某页，不指向具体段落）', () => {
  const content = structuredClone(validRtfContent())
  const validation = validateDocumentContent(content)
  assert.equal(validation.valid, true, formatViolations(validation))
  // 负例：issue 的 page 0 哨兵同样非法。
  ;(content.issues as Record<string, unknown>[])[0]!.locator = { kind: 'rtf', page: 0 }
  expectViolation(content, 'ISSUE_LOCATOR_INVALID')
})

/** 从 RTF 正例派生一个只改一处的副本。 */
function withRtfPatch(patch: (copy: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = structuredClone(validRtfContent())
  patch(copy)
  return copy
}
