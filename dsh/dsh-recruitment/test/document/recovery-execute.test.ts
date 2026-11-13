// 恢复执行器（executePlan）的独立测试：门控、收紧后的成功判据、失败即停、不伪造。
//
// 边界：这里注入的 reRead / visionRead / askHuman 都是**假能力**。本文件证明的是
// 执行器的判断逻辑（只自动执行三类动作、每步重判、三条成功判据同时成立才采纳、
// human 永不自动执行、缺 facts 的 PDF 不跑空转），**不证明**真实读取或视觉能力存在
// —— 真实能力由 U1/U3 提供（D-81），人工通道由 DSH 的人机闸门承担（D-79/D-95）。
import test from 'node:test'
import assert from 'node:assert/strict'

import type { DocumentBlock, DocumentContent, DocumentIssue } from '../../src/document/contracts/index.ts'
import { executePlan, plan } from '../../src/document/recovery/index.ts'

const SHA = 'a'.repeat(64)

/** 一页干净的原生文字块：字符保真、页覆盖、来源、跨块归属都过。 */
function cleanBlocks(): DocumentBlock[] {
  return [
    {
      block_id: 'b1',
      kind: 'paragraph',
      text: '张三',
      order: 0,
      locator: { kind: 'pdf', page: 1, bbox: [50, 60, 120, 80] },
      provenance: 'native_text',
    },
    {
      block_id: 'b2',
      kind: 'paragraph',
      text: 'Example Technology Ltd 2021.07 - 2024.06 后端工程师',
      order: 1,
      locator: { kind: 'pdf', page: 1, bbox: [50, 160, 400, 180] },
      provenance: 'native_text',
    },
  ]
}

/** 造一份 canonical DocumentContent（默认一页合格 PDF）。 */
function doc(overrides: Partial<DocumentContent> = {}): DocumentContent {
  const blocks: readonly DocumentBlock[] = overrides.blocks ?? cleanBlocks()
  return {
    schema_version: '1.0.0',
    asset_sha256: SHA,
    media_type: 'application/pdf',
    reader_id: 'pdf:pymupdf-mounted/1.28.0',
    reader_version: '1.28.0',
    text: blocks.map((block) => block.text).join('\n\n'),
    blocks,
    completeness: 'complete',
    needs_visual: false,
    issues: [],
    elapsed_ms: 8,
    ...overrides,
  }
}

/** 造一条上游 issue（severity 由稳定表重新映射，这里只给 code/message/定位）。 */
function issue(code: string, message: string, locator?: DocumentIssue['locator']): DocumentIssue {
  const base: DocumentIssue = {
    code,
    message,
    severity: 'HARD',
    retryable: false,
    suggested_action: 'none',
  }
  return locator === undefined ? base : { ...base, locator }
}

/** 读取超时：正文和块都在，但读取器报了 retry 类 HARD（计划里出现 retry 步）。 */
function timedOut(): DocumentContent {
  return doc({
    completeness: 'partial',
    issues: [issue('reader_timeout', '读取超时，没有产生可信正文')],
  })
}

/** 两条 HARD：retry 类 + 人工类（用来验证「目标消失但换了别的病」「部分修复」等判据）。 */
function mixedHard(): DocumentContent {
  return doc({
    completeness: 'partial',
    issues: [
      issue('reader_timeout', '读取超时，没有产生可信正文'),
      issue('encrypted_pdf', 'PDF 需要密码才能打开'),
    ],
  })
}

/** 整份没读出来：无块无正文 + 读取类 HARD（计划里同时出现 retry 与 vision_read）。 */
function unreadOut(extraIssues: DocumentIssue[] = []): DocumentContent {
  return doc({
    text: '',
    blocks: [],
    completeness: 'partial',
    issues: [issue('reader_timeout', '读取超时，没有产生可信正文'), ...extraIssues],
  })
}

/** 两页都补读成功后的干净内容（页 1、页 2 各有块，页覆盖完整）。 */
function twoPageClean(): DocumentContent {
  return doc({
    blocks: [
      {
        block_id: 'p1',
        kind: 'paragraph',
        text: '张三',
        order: 0,
        locator: { kind: 'pdf', page: 1, bbox: [50, 60, 120, 80] },
        provenance: 'native_text',
      },
      {
        block_id: 'p2',
        kind: 'paragraph',
        text: 'Example Technology Ltd 2021.07 - 2024.06 后端工程师',
        order: 1,
        locator: { kind: 'pdf', page: 2, bbox: [50, 160, 400, 180] },
        provenance: 'native_text',
      },
    ],
  })
}

/** canonical 契约不带页数/顺序声明，必须经 reader facts 旁路传进来（见 src/document/README §6.2）。 */
const ONE_PAGE_FACTS = { page_count: 1, order_verified: true } as const
const TWO_PAGE_FACTS = { page_count: 2, order_verified: true } as const

// ---------------------------------------------------------------------------
// 四条必备用例
// ---------------------------------------------------------------------------

test('能力全缺失：一步都不执行，content 原样，remaining 与初始计划完全一致', async () => {
  // 这个内容同时有自动步（retry / vision_read）和人工步（encrypted_pdf → human_review），
  // 否则「不执行」没有可证明的对象。factsFor 给全，避免先被 READER_FACTS_REQUIRED 拦下。
  const content = unreadOut([issue('encrypted_pdf', 'PDF 需要密码才能打开')])
  const facts = { page_count: 1, order_verified: true }
  const initial = plan(content, { facts })
  assert.deepEqual(initial.steps.map((step) => step.action), ['retry', 'vision_read', 'human_review'])

  const result = await executePlan(content, { facts, factsFor: () => facts })

  // 没有任何能力可调，就没有任何执行记录：不把「没执行」写成一条假成功。
  assert.equal(result.executed.length, 0)
  assert.equal(result.skipped_reason, null)
  assert.equal(result.content, content, '一步都没成功时不得替换内容')
  assert.deepEqual(result.remaining, initial, 'remaining 必须是原计划本身')
  assert.deepEqual(result.remaining.steps.map((step) => step.action), ['retry', 'vision_read', 'human_review'])
  assert.equal(result.remaining.blocking, true)
})

test('retry 成功让 blocking 下降：记录 succeeded、采纳新内容、remaining 无自动步', async () => {
  const content = timedOut()
  const reread = doc()
  const reasons: string[] = []

  const result = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: {
      reRead: async (reason) => {
        reasons.push(reason)
        return reread
      },
    },
  })

  assert.deepEqual(reasons, ['retry'], 'retry 步必须以 retry 原因调用 reRead')
  assert.equal(result.executed.length, 1)
  const step = result.executed[0]
  assert.ok(step !== undefined)
  assert.equal(step.status, 'succeeded')
  assert.equal(step.blocked_reason, null)
  assert.equal(step.action, 'retry')
  assert.equal(step.before.blocking, true)
  assert.equal(step.before.hard_count, 1)
  assert.equal(step.after?.blocking, false)
  assert.equal(step.after?.hard_count, 0)
  assert.match(step.reason, /三条判据同时成立/u)
  // 只有重判确认下降后才采纳新内容
  assert.equal(result.content, reread)
  assert.equal(result.skipped_reason, null)
  assert.equal(result.remaining.blocking, false)
  assert.equal(result.remaining.next, 'structure')
  assert.deepEqual(result.remaining.steps, [])
})

test('retry 返回 null：立即停止，后续 vision_read 不执行，remaining 保留 retry/vision_read', async () => {
  const content = unreadOut()
  const facts = { page_count: 1 }
  const initial = plan(content, { facts })
  let visionCalls = 0

  const result = await executePlan(content, {
    facts,
    factsFor: () => facts,
    capabilities: {
      reRead: async () => null,
      visionRead: async () => {
        visionCalls += 1
        return doc()
      },
    },
  })

  assert.equal(visionCalls, 0, 'retry 失败后不得继续执行后续自动步')
  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.status, 'failed')
  assert.equal(result.executed[0]?.action, 'retry')
  assert.equal(result.executed[0]?.blocked_reason, null)
  assert.match(result.executed[0]?.reason ?? '', /null/u)
  assert.equal(result.content, content, '失败的输出不得被采纳')
  assert.deepEqual(result.remaining, initial, '未解决的步骤必须原样留在 remaining 里')
  assert.deepEqual(result.remaining.steps.map((step) => step.action), ['retry', 'vision_read'])
  assert.equal(result.remaining.blocking, true)
  assert.equal(result.skipped_reason, null)
})

test('human_review 永不自动执行：连 askHuman 都不调，人工步原样留在 remaining', async () => {
  // (a) 纯人工步：计划里只有 human_review，执行器什么都不该做。
  const humanOnly = doc({
    completeness: 'partial',
    issues: [issue('encrypted_pdf', 'PDF 需要密码才能打开')],
  })
  let askCalls = 0
  let reReadCalls = 0
  const onlyHuman = await executePlan(humanOnly, {
    facts: ONE_PAGE_FACTS,
    capabilities: {
      reRead: async () => {
        reReadCalls += 1
        return doc()
      },
      askHuman: async () => {
        askCalls += 1
        return { accepted: true, text: '我确认' }
      },
    },
  })
  assert.equal(onlyHuman.executed.length, 0)
  assert.equal(onlyHuman.content, humanOnly)
  assert.equal(askCalls, 0, '人工通道不得被自动执行器调用（D-79/D-95：只能真人回答）')
  assert.equal(reReadCalls, 0, '没有自动步时不得无事调用能力')
  assert.deepEqual(onlyHuman.remaining.steps.map((step) => step.action), ['human_review'])
  assert.equal(onlyHuman.remaining.blocking, true)
  assert.equal(onlyHuman.remaining.next, 'human')

  // (b) 自动步成功后（2 条 HARD → 1 条，且目标 reader_timeout 消失），人工步仍留在 remaining。
  const mixed = mixedHard()
  const stillHuman = doc({
    completeness: 'partial',
    issues: [issue('encrypted_pdf', 'PDF 需要密码才能打开')],
  })
  askCalls = 0
  const mixedResult = await executePlan(mixed, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: {
      reRead: async () => stillHuman,
      askHuman: async () => {
        askCalls += 1
        return { accepted: true }
      },
    },
  })
  assert.equal(mixedResult.executed.length, 1)
  assert.equal(mixedResult.executed[0]?.status, 'succeeded', '2 条 HARD → 1 条且目标消失，判成功')
  assert.equal(mixedResult.executed[0]?.action, 'retry')
  assert.ok(mixedResult.executed.every((step) => step.action !== 'human_review'))
  assert.equal(askCalls, 0, '自动步跑完也不得替人回答')
  assert.deepEqual(mixedResult.remaining, plan(stillHuman, { facts: ONE_PAGE_FACTS }))
  assert.equal(mixedResult.remaining.steps.filter((step) => step.action === 'human_review').length, 1)
})

// ---------------------------------------------------------------------------
// 收紧点 ①：成功判据三条同时成立
// ---------------------------------------------------------------------------

test('收紧①-换病：新内容出现旧内容没有的 HARD code → failed，不采纳', async () => {
  // 执行前 2 条 HARD（reader_timeout + encrypted_pdf）；重读后只剩 1 条 HARD，
  // blocking 数确实降了、retry 目标也消失了，但换成了一条全新的 HARD code。
  const content = mixedHard()
  const swapped = doc({
    completeness: 'partial',
    issues: [issue('doc_cross_block_attribution', '跨块归属不可确认（换了一种病）')],
  })

  const result = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: { reRead: async () => swapped },
  })

  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.status, 'failed')
  assert.match(result.executed[0]?.reason ?? '', /出现了旧内容没有的 HARD code/u)
  assert.match(result.executed[0]?.reason ?? '', /doc_cross_block_attribution/u)
  assert.equal(result.content, content, '出现新 HARD code 的输出不得被采纳')
  assert.equal(result.remaining.blocking, true)
})

test('收紧①-目标未消失：blocking 降了但 retry 的目标 code 仍是 HARD → failed，不采纳', async () => {
  // 执行前 2 条 HARD；重读后只剩 reader_timeout（= retry 步自己的目标 code）。
  // HARD 数 2→1 是下降、也没有新 code，但目标问题还在 → 不算成功。
  const content = mixedHard()
  const notFixed = timedOut()

  const result = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: { reRead: async () => notFixed },
  })

  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.status, 'failed')
  assert.match(result.executed[0]?.reason ?? '', /目标 code 仍是 HARD/u)
  assert.match(result.executed[0]?.reason ?? '', /reader_timeout/u)
  assert.equal(result.content, content)
  assert.equal(result.executed[0]?.after?.hard_count, 1)
})

test('收紧①-vision 目标改用 step.codes：pdf_no_text / doc_block_missing 全部消失 → succeeded', async () => {
  // 裁决 1：判据 (c) 只认 plan 给的 step.codes，不再硬编码三条视觉 code。
  // 扫描件的 vision 步 codes = pdf_no_text / doc_block_missing，补读后两者都消失 → 成功。
  const scanned = doc({
    text: '',
    blocks: [],
    completeness: 'partial',
    issues: [issue('pdf_no_text', 'PDF 没有可机读文本层')],
  })
  const reread = twoPageClean()
  const calls: number[][] = []

  const result = await executePlan(scanned, {
    facts: TWO_PAGE_FACTS,
    capabilities: {
      visionRead: async (pages) => {
        calls.push([...pages])
        return reread
      },
    },
  })

  assert.deepEqual(calls, [[1, 2]])
  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.action, 'vision_read')
  assert.equal(result.executed[0]?.status, 'succeeded')
  assert.match(result.executed[0]?.reason ?? '', /目标问题消失/u)
  assert.equal(result.content, reread, 'step.codes 全部消失后补读结果被采纳')
  assert.equal(result.remaining.blocking, false)
})

test('收紧①-vision 目标仍在：step.codes 仍是 HARD → failed，不采纳', async () => {
  // 执行前 2 条 HARD：order（vision 目标）+ encrypted（人工）。补读只治好了 encrypted，
  // HARD 数 2→1、无新 code，但 vision 步自己的目标 code 还在 → 不算成功。
  const content = doc({
    completeness: 'partial',
    issues: [
      issue('doc_reading_order_unverified', '阅读顺序没有经过核对'),
      issue('encrypted_pdf', 'PDF 需要密码才能打开'),
    ],
  })
  const stillOrder = doc({
    completeness: 'partial',
    issues: [issue('doc_reading_order_unverified', '阅读顺序没有经过核对')],
  })

  const result = await executePlan(content, {
    facts: { page_count: 1 },
    capabilities: { visionRead: async () => stillOrder },
  })

  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.action, 'vision_read')
  assert.equal(result.executed[0]?.status, 'failed')
  assert.match(result.executed[0]?.reason ?? '', /目标 code 仍是 HARD/u)
  assert.match(result.executed[0]?.reason ?? '', /doc_reading_order_unverified/u)
  assert.equal(result.content, content)
})

test('收紧①-vision 成功：doc_reading_order_unverified 消失 → succeeded 并采纳', async () => {
  const content = doc({
    completeness: 'partial',
    issues: [issue('doc_reading_order_unverified', '阅读顺序没有经过核对')],
  })
  const reread = doc()
  const facts = { page_count: 1 }

  const result = await executePlan(content, {
    facts,
    capabilities: { visionRead: async () => reread },
  })

  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.action, 'vision_read')
  assert.equal(result.executed[0]?.status, 'succeeded')
  assert.equal(result.executed[0]?.before.hard_count, 1)
  assert.equal(result.executed[0]?.after?.hard_count, 0)
  assert.match(result.executed[0]?.reason ?? '', /目标问题消失/u)
  assert.equal(result.content, reread)
  assert.equal(result.remaining.blocking, false)
})

// ---------------------------------------------------------------------------
// 收紧点 ②：初始就不 blocking → 不执行自动步
// ---------------------------------------------------------------------------

test('收紧②-初始就不 blocking：一步都不执行，返回 skipped_reason=NOT_BLOCKING，remaining 原样', async () => {
  // 只剩 SOFT（resume_timeline_gap 是 SOFT/无需动作）：自动恢复没有可证明的修复目标。
  // 注意 raw severity 必须是 SOFT：上游 HARD 会把稳定表里的 SOFT code 升级成 HARD（不得降级）。
  const content = doc({
    completeness: 'partial',
    issues: [{
      code: 'resume_timeline_gap',
      message: '时间线断档（原文如此，未修补）',
      severity: 'SOFT',
      retryable: false,
      suggested_action: 'none',
    }],
  })
  let reReadCalls = 0

  const result = await executePlan(content, {
    facts: ONE_PAGE_FACTS,
    capabilities: {
      reRead: async () => {
        reReadCalls += 1
        return doc()
      },
    },
  })

  assert.equal(result.skipped_reason, 'NOT_BLOCKING')
  assert.equal(result.executed.length, 0)
  assert.equal(reReadCalls, 0)
  assert.equal(result.content, content)
  assert.deepEqual(result.remaining, plan(content, { facts: ONE_PAGE_FACTS }))
})

// ---------------------------------------------------------------------------
// 收紧点 ③：没有任何页数证据的 PDF 不跑空转（READER_FACTS_REQUIRED）
// ---------------------------------------------------------------------------

test('收紧③-无任何页数证据的 PDF：retry/switch_reader 直接 blocked（READER_FACTS_REQUIRED），能力一次都不调用', async () => {
  // retry 步
  const retryContent = timedOut()
  let retryCalls = 0
  const retryResult = await executePlan(retryContent, {
    capabilities: {
      reRead: async () => {
        retryCalls += 1
        return doc()
      },
    },
  })
  assert.equal(retryCalls, 0, '无任何页数证据时不得发起真实重读')
  assert.equal(retryResult.executed.length, 1)
  assert.equal(retryResult.executed[0]?.status, 'blocked')
  assert.equal(retryResult.executed[0]?.blocked_reason, 'READER_FACTS_REQUIRED')
  assert.equal(retryResult.executed[0]?.action, 'retry')
  assert.equal(retryResult.executed[0]?.after, null)
  assert.match(retryResult.executed[0]?.reason ?? '', /doc_page_count_unverified/u)
  assert.equal(retryResult.content, retryContent)
  assert.equal(retryResult.remaining.blocking, true)
  assert.ok(retryResult.remaining.steps.some((step) => step.action === 'retry'))

  // switch_reader 步
  const noReaderContent = doc({
    completeness: 'partial',
    issues: [issue('no_reader', '没有可用的读取器处理该媒体类型')],
  })
  let switchCalls = 0
  const switchResult = await executePlan(noReaderContent, {
    capabilities: {
      reRead: async () => {
        switchCalls += 1
        return doc()
      },
    },
  })
  assert.equal(switchCalls, 0)
  assert.equal(switchResult.executed[0]?.status, 'blocked')
  assert.equal(switchResult.executed[0]?.blocked_reason, 'READER_FACTS_REQUIRED')
  assert.equal(switchResult.executed[0]?.action, 'switch_reader')

  // 静态 facts 存在但没有页数 → 仍不算「能提供页数证据」，判 blocked。
  let partialFactsCalls = 0
  const noPageCount = await executePlan(timedOut(), {
    facts: { order_verified: true },
    capabilities: {
      reRead: async () => {
        partialFactsCalls += 1
        return doc()
      },
    },
  })
  assert.equal(partialFactsCalls, 0)
  assert.equal(noPageCount.executed[0]?.status, 'blocked')
  assert.equal(noPageCount.executed[0]?.blocked_reason, 'READER_FACTS_REQUIRED')
})

test('收紧③-静态 facts 已有页数：允许执行（不再要求必须给 factsFor）', async () => {
  // 裁决 2：factsFor 存在，或静态 facts.page_count 为正数，都算有页数证据。
  const content = timedOut()
  const reread = doc()

  const result = await executePlan(content, {
    facts: ONE_PAGE_FACTS, // 故意不给 factsFor
    capabilities: { reRead: async () => reread },
  })

  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.status, 'succeeded')
  assert.equal(result.content, reread)
  assert.equal(result.remaining.blocking, false)
})

test('收紧③-factsFor 给出但没有页数：重读结果出现新 HARD code → failed；补上页数才成功', async () => {
  const content = timedOut()
  const reread = doc()

  // factsFor 存在（满足前置条件，重读会发生），但拿不到页数 → 重读结果必然出现
  // doc_page_count_unverified 这个旧内容没有的 HARD code。
  let calls = 0
  const withoutPages = await executePlan(content, {
    factsFor: () => ({}),
    capabilities: {
      reRead: async () => {
        calls += 1
        return reread
      },
    },
  })
  assert.equal(calls, 1, 'factsFor 存在时允许发起重读')
  assert.equal(withoutPages.executed[0]?.status, 'failed')
  assert.match(withoutPages.executed[0]?.reason ?? '', /旧内容没有的 HARD code/u)
  assert.match(withoutPages.executed[0]?.reason ?? '', /doc_page_count_unverified/u)
  assert.equal(withoutPages.content, content)

  // 补上页数事实 → 同一份重读内容这次判成功。
  const withPages = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: { reRead: async () => reread },
  })
  assert.equal(withPages.executed[0]?.status, 'succeeded')
  assert.equal(withPages.content, reread)
  assert.equal(withPages.remaining.blocking, false)
})

// ---------------------------------------------------------------------------
// 其余失败/边界
// ---------------------------------------------------------------------------

test('switch_reader：把 switch_reader 原因交给 reRead；成功同样以三条判据为准', async () => {
  const content = doc({
    completeness: 'partial',
    issues: [issue('no_reader', '没有可用的读取器处理该媒体类型')],
  })
  const reasons: string[] = []

  const result = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: {
      reRead: async (reason) => {
        reasons.push(reason)
        return doc()
      },
    },
  })

  assert.deepEqual(reasons, ['switch_reader'])
  assert.equal(result.executed[0]?.action, 'switch_reader')
  assert.equal(result.executed[0]?.status, 'succeeded')
  assert.equal(result.remaining.blocking, false)
})

test('超时：按失败停止，不采纳、不谎报成功', async () => {
  const content = timedOut()
  const hang = new Promise<DocumentContent | null>(() => {})

  const result = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    step_timeout_ms: 25,
    capabilities: { reRead: async () => hang },
  })

  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.status, 'failed')
  assert.match(result.executed[0]?.reason ?? '', /StepTimeoutError|超时/u)
  assert.equal(result.content, content)
  assert.equal(result.remaining.blocking, true)
})

test('返回了内容但 blocking 没下降：按失败处理，不采纳', async () => {
  const content = timedOut()
  const unchanged = timedOut()

  const result = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: { reRead: async () => unchanged },
  })

  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.status, 'failed')
  assert.match(result.executed[0]?.reason ?? '', /blocking 没有下降/u)
  assert.equal(result.content, content, '没有下降的输出不得被采纳')
  assert.ok(result.executed[0]?.after !== null, '必须留下重判快照供审计')
  assert.equal(result.executed[0]?.after?.hard_count, 1)
  assert.equal(result.remaining.blocking, true)
})

test('返回另一份材料（asset_sha256 不同）：拒绝采纳', async () => {
  const content = timedOut()
  const other = doc({ asset_sha256: 'c'.repeat(64) })

  const result = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: { reRead: async () => other },
  })

  assert.equal(result.executed[0]?.status, 'failed')
  assert.match(result.executed[0]?.reason ?? '', /asset_sha256|另一份材料/u)
  assert.equal(result.content, content)
})

test('能力返回的不是 DocumentContent（例如字符串）：拒绝采纳，不崩', async () => {
  const content = timedOut()

  const result = await executePlan(content, {
    factsFor: () => ONE_PAGE_FACTS,
    capabilities: { reRead: async () => 'not-a-document-content' as unknown as DocumentContent },
  })

  assert.equal(result.executed.length, 1)
  assert.equal(result.executed[0]?.status, 'failed')
  assert.match(result.executed[0]?.reason ?? '', /不是 DocumentContent|拒绝采纳/u)
  assert.equal(result.content, content)
})

test('计划已标 blocked（模型不支持图像）：不越权执行，remaining 原样', async () => {
  const scanned = doc({
    text: '',
    blocks: [],
    completeness: 'partial',
    issues: [issue('pdf_no_text', 'PDF 没有可机读文本层')],
  })
  const facts = { page_count: 1 }
  const options = { facts, model_supports_image: false }
  let visionCalls = 0

  const result = await executePlan(scanned, {
    ...options,
    capabilities: {
      visionRead: async () => {
        visionCalls += 1
        return doc()
      },
    },
  })

  assert.equal(visionCalls, 0, '计划标 blocked 的步不得执行')
  assert.equal(result.executed.length, 0)
  assert.equal(result.content, scanned)
  assert.deepEqual(result.remaining, plan(scanned, options))
  assert.ok(result.remaining.steps.some(
    (step) => step.action === 'vision_read' && step.status === 'blocked',
  ))
})

test('视觉步只有帧号（无页号）：不把帧号谎报成页码，visionRead 不被调用', async () => {
  const image = doc({
    media_type: 'image/png',
    reader_id: 'image:ocr',
    text: 'RESUME IMAGE',
    blocks: [{
      block_id: 'i1',
      kind: 'paragraph',
      text: 'RESUME IMAGE',
      order: 0,
      locator: { kind: 'image', frame: 0 },
      provenance: 'ocr',
    }],
    completeness: 'partial',
    issues: [issue('unread_visual_page', '低文本页含图形', { kind: 'image', frame: 0 })],
  })
  let visionCalls = 0

  const result = await executePlan(image, {
    capabilities: {
      visionRead: async () => {
        visionCalls += 1
        return image
      },
    },
  })

  assert.equal(visionCalls, 0, '帧号不是页码，不得交给 visionRead(pages)')
  assert.equal(result.executed.length, 0)
  assert.equal(result.content, image)
  assert.ok(result.remaining.steps.some((step) => step.action === 'vision_read'))
})
