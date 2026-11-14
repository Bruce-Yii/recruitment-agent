// S6 身份来源闸门（D-67 / IR-G2 / IR-F4）的回归矩阵（真库 ra_s6s7，每个用例必回滚）。
//
// 守的只有一件事：**只有 `provenance='native_text'` 的 phone/email 可以自动归并**；
// `ocr` / `agent_read` / 缺失（`unknown`）只能进 `weak`（提示），不得进入
// `material.strong` / `identity.identity_merge_eligible`，也不得驱动新建/关联。
//
// 2026-11-14 独立验收 P0-01 的原始缺陷：
//   * `structured_json` 的 `agent_read` 电话/邮箱被直接 push 进 `strong`；
//   * converter 把整页 OCR 重读块的字段标成 `native_text` 并进入 `identity_merge_eligible`。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStructuredJson,
  buildMaterial,
  intakeInTransaction,
  type IntakeMaterial,
} from '../../src/tools/application-intake.ts'
import type { ConverterOutput } from '../../src/tools/converter.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  DEMO_JOB,
  hex64,
  inRolledBackTx,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)
const PDF = 'D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter\\corpus\\synthetic\\zero_text.pdf'

test.after(async () => {
  await pool.end()
})

// ---------------------------------------------------------------------------
//  夹具（全部合成，无真实个人资料）
// ---------------------------------------------------------------------------

interface Fixture {
  readonly sha: string
  readonly phone: string
  readonly email: string
  readonly blocks: readonly Record<string, unknown>[]
}

/** 三块合成简历（块文本与 `structured_json` 的 block 引用一一对应）。 */
function fixture(seed: string): Fixture {
  const suffix = uniqueSuffix()
  const digits = String(Number.parseInt(hex64(`gate-phone-${suffix}`).slice(0, 8), 16) % 100_000_000).padStart(8, '0')
  const phone = `139${digits}`
  const email = `gate.${suffix}@example.test`
  return {
    sha: hex64(`${seed}${suffix}`),
    phone,
    email,
    blocks: [
      { kind: 'paragraph', text: '姓名：张示例', location: { page: 1, bbox: [72, 100, 520, 120] }, provenance: 'native_text' },
      { kind: 'paragraph', text: `电话：${phone}  邮箱：${email}`, location: { page: 1, bbox: [72, 130, 520, 150] }, provenance: 'native_text' },
      { kind: 'paragraph', text: '示例科技 工程师 2020.07-2023.06', location: { page: 1, bbox: [72, 200, 520, 220] }, provenance: 'native_text' },
    ],
  }
}

/** converter 字段条目（`provenance` 可省略 = 缺失 provenance 的 fail-closed 用例）。 */
function fieldEntry(input: {
  state: string
  value?: string
  provenance?: string
  reason?: string
  evidence?: readonly Record<string, unknown>[]
}): Record<string, unknown> {
  const evidence = input.evidence ?? (input.state === 'present'
    ? [{ page: 1, bbox: [72, 130, 520, 150], block: 2, text: input.value ?? '' }]
    : [])
  return {
    state: input.state,
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    evidence,
  }
}

/**
 * 造一份 converter 输出。
 * @param input.phone - phone 字段条目；不给就是 unreadable。
 * @param input.email - email 字段条目；不给就是 unreadable。
 * @param input.eligible - `screening.identity_merge_eligible`（真实 converter 只放 native 字段）。
 */
function makeOutput(fx: Fixture, input: {
  readonly phone?: Record<string, unknown>
  readonly email?: Record<string, unknown>
  readonly eligible?: readonly string[]
} = {}): ConverterOutput {
  return {
    text: fx.blocks.map((block) => String(block.text)).join('\n'),
    chars: 120,
    completeness: 'complete',
    issues: [],
    blocks: [...fx.blocks],
    fields: {
      name: fieldEntry({ state: 'present', value: '张示例', provenance: 'native_text', evidence: [{ page: 1, bbox: [72, 100, 520, 120], block: 1, text: '姓名：张示例' }] }),
      phone: input.phone ?? fieldEntry({ state: 'unreadable', reason: 'value_masked_or_redacted' }),
      email: input.email ?? fieldEntry({ state: 'unreadable', reason: 'value_masked_or_redacted' }),
      work_experience: fieldEntry({ state: 'unreadable', reason: 'entries_not_segmentable' }),
      education: fieldEntry({ state: 'absent', reason: 'not_mentioned' }),
    },
    timeline: { intervals: 0, closed_intervals: 0, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 0 },
    screening: {
      eligible_fields: ['name'],
      blocked_fields: [],
      identity_merge_eligible: [...(input.eligible ?? [])],
    },
    meta: { pages: 1, source_sha256: fx.sha, backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  } as ConverterOutput
}

/** 与三块 PDF 对应的结构化结果（agent 读出的 phone/email 必然是 `agent_read`）。 */
function structuredDoc(fx: Fixture): Record<string, unknown> {
  return {
    prompt_version: '1.0.0',
    schema_version: '1.0.0',
    block_count: 3,
    sections: [
      { label: 'contact', block_ids: ['1', '2'] },
      { label: 'work_experience', block_ids: ['3'] },
    ],
    fields: {
      name: { state: 'present', value: '张示例', block_ids: ['1'] },
      phone: { state: 'present', value: fx.phone, block_ids: ['2'] },
      email: { state: 'present', value: fx.email, block_ids: ['2'] },
      work_experience: {
        state: 'present',
        block_ids: ['3'],
        value: [{
          company: { value: '示例科技', block_ids: ['3'] },
          title: { value: '工程师', block_ids: ['3'] },
          start: { value: '2020.07', block_ids: ['3'] },
          end: { value: '2023.06', block_ids: ['3'] },
          block_ids: ['3'],
          attribution: 'single_block',
        }],
      },
      education: { state: 'absent', reason: 'not_mentioned', block_ids: [] },
    },
  }
}

function materialFor(fx: Fixture, output: ConverterOutput): IntakeMaterial {
  return buildMaterial(PDF, output)
}

async function count(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: string }>(sql, [...params])
  return Number(rows[0]?.n ?? '0')
}

/** 六张会被 intake 写入的表，用于"拒绝时一行不写"。 */
async function materialRowCounts(client: DatabaseClient): Promise<number[]> {
  const tables = [
    'recruitment.candidate',
    'recruitment.application',
    'recruitment.resume',
    'recruitment.resume_version',
    'recruitment.intake_record',
    'recruitment.intake_asset',
  ]
  const counts: number[] = []
  for (const table of tables) {
    counts.push(await count(client, `select count(*) as n from ${table} where tenant_id = $1`, [TENANT]))
  }
  return counts
}

/** 阻断错误里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
function blockedBody(error: unknown): {
  reason_code?: string
  detail?: { weak_fields?: { field: string; provenance: string; reason: string }[] }
} {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as {
    reason_code?: string
    detail?: { weak_fields?: { field: string; provenance: string; reason: string }[] }
  }
}

// ---------------------------------------------------------------------------
//  ① native_text → strong（正例，闸门不得做成全阻塞）
// ---------------------------------------------------------------------------

test('native_text 电话/邮箱 → 进 strong，identity_merge_eligible 只含 native 字段', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fx = fixture('native')
    const material = materialFor(fx, makeOutput(fx, {
      phone: fieldEntry({ state: 'present', value: fx.phone, provenance: 'native_text' }),
      email: fieldEntry({ state: 'present', value: fx.email, provenance: 'native_text' }),
      eligible: ['phone', 'email'],
    }))

    assert.deepEqual(material.strong.map((id) => id.field), ['phone', 'email'])
    assert.deepEqual(material.strong.map((id) => id.provenance), ['native_text', 'native_text'])
    assert.deepEqual(material.weak ?? [], [])

    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.deepEqual(value.identity.strong_ids, ['email', 'phone'])
    assert.deepEqual(value.identity.identity_merge_eligible, ['email', 'phone'])
    assert.deepEqual(value.identity.weak_fields, [])
  })
})

// ---------------------------------------------------------------------------
//  ② ocr 邮箱 → weak（不进 strong / identity_merge_eligible）
// ---------------------------------------------------------------------------

test('ocr 邮箱 → 只进 weak；identity_merge_eligible 不含它（native 电话仍可自动）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fx = fixture('ocr')
    const material = materialFor(fx, makeOutput(fx, {
      phone: fieldEntry({ state: 'present', value: fx.phone, provenance: 'native_text' }),
      // 真实 converter 已不再把 OCR 字段列进 identity_merge_eligible；这里仍给 ['phone']，
      // 用来证明 S6 的判据是 provenance，而不是照抄 converter 的清单。
      email: fieldEntry({ state: 'present', value: fx.email, provenance: 'ocr' }),
      eligible: ['phone'],
    }))

    assert.deepEqual(material.strong.map((id) => id.field), ['phone'])
    assert.deepEqual(material.weak?.map((id) => id.field), ['email'])
    assert.equal(material.weak?.[0]?.provenance, 'ocr')
    assert.equal(material.weak?.[0]?.reason, 'provenance_ocr')
    assert.equal(material.weak?.[0]?.norm, fx.email.toLowerCase())

    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.deepEqual(value.identity.strong_ids, ['phone'])
    assert.deepEqual(value.identity.identity_merge_eligible, ['phone'], 'OCR 邮箱绝不可自动归并')
    assert.ok(value.identity.identity_merge_eligible.includes('email') === false)
    assert.deepEqual(value.identity.weak_fields, [
      { field: 'email', provenance: 'ocr', reason: 'provenance_ocr' },
    ])
  })
})

test('ocr 电话 + ocr 邮箱（无 native）→ 两者都只是 weak，整个接入 BLOCKED_BY_REVIEW 且一行不写', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fx = fixture('ocr-all')
    const material = materialFor(fx, makeOutput(fx, {
      phone: fieldEntry({ state: 'present', value: fx.phone, provenance: 'ocr' }),
      email: fieldEntry({ state: 'present', value: fx.email, provenance: 'ocr' }),
      eligible: [],
    }))
    assert.deepEqual(material.strong, [])
    assert.deepEqual(material.weak?.map((id) => id.field), ['phone', 'email'])

    const before = await materialRowCounts(client)
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      const body = blockedBody(error)
      assert.equal(body.reason_code, 'MATERIAL_ATTRIBUTION_UNKNOWN')
      assert.deepEqual(body.detail?.weak_fields?.map((item) => item.field), ['phone', 'email'])
      return true
    })
    const after = await materialRowCounts(client)
    assert.deepEqual(after, before, 'OCR 来源不足时一行都不许写（不得判新人/重复）')
  })
})

// ---------------------------------------------------------------------------
//  ③ agent_read（structured_json）→ weak，绝不进 strong
// ---------------------------------------------------------------------------

test('structured_json 的 phone/email（agent_read）→ 全部进 weak；agent-only 身份被拒绝且不写行', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fx = fixture('agent')
    const base = materialFor(fx, makeOutput(fx)) // converter 两个字段都 unreadable
    assert.deepEqual(base.strong, [])

    const material = applyStructuredJson(base, JSON.stringify(structuredDoc(fx)), DEMO_JOB)
    // 核心断言：agent 读出的字段没有任何一条进入 strong（D-67 / IR-F4）。
    assert.deepEqual(material.strong, [], 'agent_read 绝不进 strong')
    assert.deepEqual(material.weak?.map((id) => id.field), ['phone', 'email'])
    assert.deepEqual(material.weak?.map((id) => id.provenance), ['agent_read', 'agent_read'])
    assert.deepEqual(material.weak?.map((id) => id.reason), ['provenance_agent_read', 'provenance_agent_read'])

    const before = await materialRowCounts(client)
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      const body = blockedBody(error)
      assert.equal(body.reason_code, 'MATERIAL_ATTRIBUTION_UNKNOWN')
      assert.deepEqual(body.detail?.weak_fields?.map((item) => item.provenance), ['agent_read', 'agent_read'])
      return true
    })
    const after = await materialRowCounts(client)
    assert.deepEqual(after, before, 'agent-only 身份不得自动建候选人/申请')
  })
})

test('structured_json 不删除转换器已有的 native 强标识（只有模型判非 present 才让它失效）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fx = fixture('agent-native')
    const base = materialFor(fx, makeOutput(fx, {
      phone: fieldEntry({ state: 'present', value: fx.phone, provenance: 'native_text' }),
      eligible: ['phone'],
    }))
    const material = applyStructuredJson(base, JSON.stringify(structuredDoc(fx)), DEMO_JOB)
    // 原生证据不因"带了结构化结果"被清掉；agent 对同一字段的读出只作提示。
    assert.deepEqual(material.strong.map((id) => id.field), ['phone'])
    assert.equal(material.strong[0]?.provenance, 'native_text')
    // phone 已有 native 强标识 ⇒ 不再重复列弱提示；email（converter 读不出、agent 读出）仍是 weak。
    assert.deepEqual(material.weak?.map((id) => id.field), ['email'])

    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.deepEqual(value.identity.identity_merge_eligible, ['phone'])
    assert.deepEqual(value.identity.strong_ids, ['phone'])
  })
})

test('结构化结果把 phone 判成 unreadable → 转换器的旧强标识必须失效（D-29 状态以模型层为准）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fx = fixture('agent-downgrade')
    const base = materialFor(fx, makeOutput(fx, {
      phone: fieldEntry({ state: 'present', value: fx.phone, provenance: 'native_text' }),
      eligible: ['phone'],
    }))
    const doc = structuredDoc(fx) as Record<string, any>
    doc.fields.phone = { state: 'unreadable', reason: 'value_masked_or_redacted', block_ids: ['2'] }
    const material = applyStructuredJson(base, JSON.stringify(doc), DEMO_JOB)
    assert.deepEqual(material.strong, [], '模型说读不出 → 不得继续拿旧 native 值自动归并')

    const before = await materialRowCounts(client)
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      const body = blockedBody(error)
      assert.equal(body.reason_code, 'MATERIAL_ATTRIBUTION_UNKNOWN')
      return true
    })
    const after = await materialRowCounts(client)
    assert.deepEqual(after, before)
  })
})

// ---------------------------------------------------------------------------
//  ④ provenance 缺失 → weak（fail-closed：缺失不是 native_text）
// ---------------------------------------------------------------------------

test('provenance 缺失的电话 → 只进 weak（reason=provenance_unknown），不得当强标识', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fx = fixture('missing')
    // 刻意把字段列进 identity_merge_eligible：证明闸门先看 provenance，不看清单。
    const material = materialFor(fx, makeOutput(fx, {
      phone: fieldEntry({ state: 'present', value: fx.phone }), // 没有 provenance 键
      eligible: ['phone'],
    }))

    assert.deepEqual(material.strong, [], '缺失 provenance 一律 fail-closed，不得当强标识')
    assert.deepEqual(material.weak?.map((id) => id.field), ['phone'])
    assert.equal(material.weak?.[0]?.provenance, 'unknown')
    assert.equal(material.weak?.[0]?.reason, 'provenance_unknown')

    const before = await materialRowCounts(client)
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      const body = blockedBody(error)
      assert.equal(body.reason_code, 'MATERIAL_ATTRIBUTION_UNKNOWN')
      assert.deepEqual(body.detail?.weak_fields?.map((item) => item.provenance), ['unknown'])
      return true
    })
    const after = await materialRowCounts(client)
    assert.deepEqual(after, before)
  })
})
