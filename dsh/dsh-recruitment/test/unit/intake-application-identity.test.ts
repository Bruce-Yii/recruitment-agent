// Application 身份（`(candidate, job, ACTIVE)`）× `resume_version` 不可变的**纯逻辑**测试。
//
// 守的是 Issue #1 §1.2/§1.3 的三条，全部可机检、连库零依赖：
//   1. `submissionDigest()` 只看内容+结构化结果（键顺序/空白不敏感），**不是**文件 sha 判等；
//   2. `decideVersionAction()` 的五档（幂等 / 首次 / 新结构化 / 不许降级 / 重新解析）；
//   3. `ensureActiveApplication()` 的三条路（复用 / 新建 / 23505 撞索引后回读复用）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStructuredJson,
  decideVersionAction,
  ensureActiveApplication,
  findActiveApplication,
  submissionDigest,
  type ExistingVersion,
  type IntakeMaterial,
} from '../../src/tools/application-intake.ts'
import { normEmail, normPhone, strongIdentityKey, type StrongId } from '../../src/db/identity.ts'
import type { ConverterOutput } from '../../src/tools/converter.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'

const JOB = '11111111-1111-4111-8111-000000000401'
const JOB_VERSION = '11111111-1111-4111-8111-000000000402'
const TENANT = '11111111-1111-4111-8111-000000000001'
const CANDIDATE = '11111111-1111-4111-8111-000000000601'
const SHA = 'a'.repeat(64)

/** 六块合成简历（自编文本，无真实个人资料）。 */
const BLOCKS = [
  { kind: 'paragraph', text: '张示例', location: { page: 1, bbox: [72, 100, 300, 120] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '电话：138 0000 1234  邮箱：zhang.example@example.test', location: { page: 1, bbox: [72, 130, 520, 150] }, provenance: 'native_text' },
  { kind: 'heading', text: '工作经历', location: { page: 1, bbox: [72, 170, 300, 190] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '示例科技有限公司 后端工程师 2020.07-2023.06', location: { page: 1, bbox: [72, 200, 520, 220] }, provenance: 'native_text' },
  { kind: 'heading', text: '教育背景', location: { page: 1, bbox: [72, 240, 300, 260] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '示例大学 计算机科学 本科 2016.09-2020.06', location: { page: 1, bbox: [72, 270, 520, 290] }, provenance: 'native_text' },
] as const

/** 转换器口径：五个字段都读不出（身份只能靠 structured_json 提供）。 */
function makeOutput(sha = SHA): ConverterOutput {
  return {
    text: BLOCKS.map((block) => block.text).join('\n'),
    chars: 200,
    completeness: 'complete',
    issues: [],
    blocks: [...BLOCKS],
    fields: {
      name: { state: 'unreadable', reason: 'value_masked_or_redacted', provenance: 'native_text', evidence: [] },
      phone: { state: 'unreadable', reason: 'value_masked_or_redacted', provenance: 'native_text', evidence: [] },
      email: { state: 'unreadable', reason: 'value_masked_or_redacted', provenance: 'native_text', evidence: [] },
      work_experience: { state: 'unreadable', reason: 'entries_not_segmentable', provenance: 'native_text', evidence: [] },
      education: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
    },
    timeline: { intervals: 0, closed_intervals: 0, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 0 },
    screening: { eligible_fields: [], blocked_fields: [], identity_merge_eligible: [] },
    meta: { pages: 1, source_sha256: sha, source_name: 'intake-identity-unit.pdf', backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  } as ConverterOutput
}

function makeMaterial(sha = SHA): IntakeMaterial {
  return {
    real_path: 'C:/fake/intake-identity-unit.pdf',
    file_name: 'intake-identity-unit.pdf',
    byte_size: 1024,
    output: makeOutput(sha),
    strong: [],
    blocked: [],
    sha256: sha,
  }
}

/** 契约形状的结构化结果（能被当前 validate() 接受）。 */
function contractShape(): Record<string, unknown> {
  return {
    prompt_version: '1.0.0',
    schema_version: '1.0.0',
    block_count: 6,
    sections: [
      { label: 'contact', block_ids: ['1', '2'] },
      { label: 'work_experience', block_ids: ['3', '4'] },
      { label: 'education', block_ids: ['5', '6'] },
    ],
    fields: {
      name: { state: 'present', value: '张示例', block_ids: ['1'] },
      phone: { state: 'present', value: '138 0000 1234', block_ids: ['2'] },
      email: { state: 'present', value: 'zhang.example@example.test', block_ids: ['2'] },
      work_experience: {
        state: 'present',
        block_ids: ['3', '4'],
        value: [
          {
            company: { value: '示例科技有限公司', block_ids: ['4'] },
            title: { value: '后端工程师', block_ids: ['4'] },
            start: { value: '2020.07', block_ids: ['4'] },
            end: { value: '2023.06', block_ids: ['4'] },
            block_ids: ['4'],
            attribution: 'single_block',
          },
        ],
      },
      education: {
        state: 'present',
        block_ids: ['5', '6'],
        value: [
          {
            school: { value: '示例大学', block_ids: ['6'] },
            major: { value: '计算机科学', block_ids: ['6'] },
            degree: { value: '本科', block_ids: ['6'] },
            start: { value: '2016.09', block_ids: ['6'] },
            end: { value: '2020.06', block_ids: ['6'] },
            block_ids: ['6'],
            attribution: 'single_block',
          },
        ],
      },
    },
  }
}

/** 同一份结构化内容的**换键顺序**副本（模拟模型每次输出键序不同）。 */
function reorderedStructured(): string {
  const doc = contractShape()
  const fields = doc.fields as Record<string, unknown>
  const reordered: Record<string, unknown> = {}
  for (const key of Object.keys(fields).reverse()) reordered[key] = fields[key]
  return JSON.stringify({
    fields: reordered,
    sections: doc.sections,
    block_count: doc.block_count,
    schema_version: doc.schema_version,
    prompt_version: doc.prompt_version,
  })
}

// ---------------------------------------------------------------------------
//  1. submissionDigest
// ---------------------------------------------------------------------------

test('digest：同一内容 + 同一结构化结果（键顺序不同）→ 指纹相同', () => {
  const base = makeMaterial()
  const a = applyStructuredJson(base, JSON.stringify(contractShape()), JOB)
  const b = applyStructuredJson(base, reorderedStructured(), JOB)
  assert.equal(submissionDigest(a), submissionDigest(b))
  assert.match(submissionDigest(a), /^[0-9a-f]{64}$/)
})

test('digest：没有结构化的提交与有结构化的提交**不同**（否则 replay 会吞掉结构化结果）', () => {
  const plain = makeMaterial()
  const structured = applyStructuredJson(makeMaterial(), JSON.stringify(contractShape()), JOB)
  assert.notEqual(submissionDigest(plain), submissionDigest(structured))
})

test('digest：业务字段一变（state / reason）→ 指纹就变；值不在原文里先被 validate 拒', () => {
  const base = makeMaterial()
  const first = applyStructuredJson(base, JSON.stringify(contractShape()), JOB)

  // 原文里没有的值：validate 拒绝（不降级接受），根本到不了 digest。
  const notInSource = contractShape() as Record<string, any>
  notInSource.fields.phone = { state: 'present', value: '139 0000 9999', block_ids: ['2'] }
  assert.throws(() => applyStructuredJson(base, JSON.stringify(notInSource), JOB))

  // 同一份 PDF 上合法的另一种结构化结论：work_experience 改成 unreadable（带 reason）。
  const downgraded = contractShape() as Record<string, any>
  downgraded.fields.work_experience = { state: 'unreadable', reason: 'entries_not_segmentable', block_ids: ['3'] }
  const second = applyStructuredJson(base, JSON.stringify(downgraded), JOB)
  assert.notEqual(submissionDigest(first), submissionDigest(second))
})

test('digest：文件字节 sha 变了但正文/结构化相同 → 指纹不同（原件溯源必须区分）', () => {
  const a = applyStructuredJson(makeMaterial('a'.repeat(64)), JSON.stringify(contractShape()), JOB)
  const b = applyStructuredJson(makeMaterial('b'.repeat(64)), JSON.stringify(contractShape()), JOB)
  assert.notEqual(submissionDigest(a), submissionDigest(b))
})

// ---------------------------------------------------------------------------
//  2. decideVersionAction
// ---------------------------------------------------------------------------

function version(id: string, versionNo: number, digest: string | null, hasStructure: boolean): ExistingVersion {
  return { id, version_no: versionNo, digest, has_structure: hasStructure }
}

test('版本决定 1：该材料链上还没有版本 → APPEND（首次接入必须先有事实）', () => {
  assert.deepEqual(decideVersionAction({ digest: 'd1', hasStructured: false, existing: [] }), { action: 'APPEND' })
})

test('版本决定 2：已有相同 digest → UNCHANGED 并指向那一版（幂等，不写行）', () => {
  assert.deepEqual(
    decideVersionAction({ digest: 'd1', hasStructured: true, existing: [version('v1', 1, 'd1', true)] }),
    { action: 'UNCHANGED', matched_version_id: 'v1' },
  )
})

test('版本决定 3：带新结构化结果 → APPEND（replay 不是 discard）', () => {
  assert.deepEqual(
    decideVersionAction({ digest: 'd2', hasStructured: true, existing: [version('v1', 1, 'd1', false)] }),
    { action: 'APPEND' },
  )
})

test('版本决定 4：无结构化的 replay 撞上已有结构化版本 → UNCHANGED，绝不用贫瘠版本覆盖', () => {
  assert.deepEqual(
    decideVersionAction({ digest: 'plain', hasStructured: false, existing: [version('v1', 1, 'd1', true)] }),
    { action: 'UNCHANGED', matched_version_id: null },
  )
})

test('版本决定 5：无结构化、已有版本也没有结构化 → APPEND（重新解析的事实要可追踪）', () => {
  assert.deepEqual(
    decideVersionAction({ digest: 'reparse', hasStructured: false, existing: [version('v1', 1, 'd1', false)] }),
    { action: 'APPEND' },
  )
})

test('版本决定：旧行没有 version_digest（digest=null）时永不匹配', () => {
  assert.deepEqual(
    decideVersionAction({ digest: 'd1', hasStructured: true, existing: [version('v1', 1, null, true)] }),
    { action: 'APPEND' },
  )
})

// ---------------------------------------------------------------------------
//  3. strongIdentityKey（并发锁的 key 成分，不是申请身份）
// ---------------------------------------------------------------------------

function strongPhone(raw: string): StrongId {
  const normalized = normPhone(raw) as { norm: string; region_ambiguous: boolean }
  return {
    field: 'phone',
    raw,
    norm: normalized.norm,
    region_ambiguous: normalized.region_ambiguous,
    provenance: 'native_text',
    evidence: [{ page: 1, bbox: [0, 0, 1, 1], block: 1, quote: raw }],
  }
}

function strongEmail(raw: string): StrongId {
  return {
    field: 'email',
    raw,
    norm: normEmail(raw) as string,
    region_ambiguous: false,
    provenance: 'native_text',
    evidence: [{ page: 1, bbox: [0, 0, 1, 1], block: 1, quote: raw }],
  }
}

test('identity key：空集合/只有不可用标识 → null（不锁，反正会被拒）', () => {
  assert.equal(strongIdentityKey([]), null)
  // 裸号码 region_ambiguous ⇒ 不参与自动关联，也不参与锁
  assert.equal(strongIdentityKey([strongPhone('01088886666')]), null)
})

test('identity key：排序 + 去重，与入参顺序无关（同一个人才会撞同一个 key）', () => {
  const phone = strongPhone('13900001111')
  const email = strongEmail('a@example.test')
  const a = strongIdentityKey([phone, email])
  const b = strongIdentityKey([email, phone, phone])
  assert.equal(a, b)
  assert.equal(a, 'email=a@example.test|phone=+8613900001111')
})

// ---------------------------------------------------------------------------
//  4. ensureActiveApplication（含 23505 回读分支）
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly sql: string
  readonly params: readonly unknown[]
}

/** 造一个只认这几条 SQL 的假客户端（记录调用，用于断言走了哪条路）。 */
function fakeClient(options: {
  /** 第 n 次 select 返回哪一行；`null` 表示"没查到"。 */
  readonly activeRows: readonly (Record<string, unknown> | null)[]
  readonly insertError?: unknown
  readonly updatedRow?: Record<string, unknown>
}): { client: DatabaseClient; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  let activeQueries = 0
  const client = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params: [...params] })
      const text = sql.trim().toLowerCase()
      if (text.startsWith('select') && text.includes('lifecycle_status = \'active\'')) {
        const row = options.activeRows[activeQueries]
        activeQueries += 1
        return { rows: row === undefined || row === null ? [] : [row] }
      }
      if (text.startsWith('insert into recruitment.application')) {
        if (options.insertError !== undefined) throw options.insertError
        return { rows: [{ id: 'new-app', record_version: 1, stage_code: 'S6', lifecycle_status: 'ACTIVE', job_version_id: JOB_VERSION, resume_version_id: params[4] }] }
      }
      if (text.startsWith('update recruitment.application')) {
        return { rows: [options.updatedRow ?? { id: 'x', record_version: 3, stage_code: 'S6', lifecycle_status: 'ACTIVE', job_version_id: JOB_VERSION, resume_version_id: params[1] }] }
      }
      throw new Error(`fakeClient: unexpected sql: ${sql.slice(0, 80)}`)
    },
  } as unknown as DatabaseClient
  return { client, calls }
}

test('申请：已有 ACTIVE → REUSED；指针不同才 UPDATE，且 record_version 取回新值', async () => {
  const { client, calls } = fakeClient({
    activeRows: [{
      id: 'app-1', record_version: 1, stage_code: 'S6', lifecycle_status: 'ACTIVE',
      job_version_id: JOB_VERSION, resume_version_id: 'old-version',
    }],
    updatedRow: {
      id: 'app-1', record_version: 3, stage_code: 'S6', lifecycle_status: 'ACTIVE',
      job_version_id: JOB_VERSION, resume_version_id: 'new-version',
    },
  })
  const result = await ensureActiveApplication(client, {
    tenantId: TENANT, candidateId: CANDIDATE, jobId: JOB,
    jobVersionId: JOB_VERSION, resumeVersionId: 'new-version',
  })
  assert.equal(result.action, 'REUSED')
  assert.equal(result.id, 'app-1')
  assert.equal(result.resume_version_id, 'new-version')
  assert.equal(result.record_version, 3, '必须用 RETURNING 的新值，不能自己 +1')
  assert.equal(calls.filter((call) => call.sql.includes('insert into recruitment.application')).length, 0)
})

test('申请：已有 ACTIVE 且指针已相同 → 一条 UPDATE 都不发（幂等无写入）', async () => {
  const { client, calls } = fakeClient({
    activeRows: [{
      id: 'app-1', record_version: 2, stage_code: 'S7', lifecycle_status: 'ACTIVE',
      job_version_id: JOB_VERSION, resume_version_id: 'same-version',
    }],
  })
  const result = await ensureActiveApplication(client, {
    tenantId: TENANT, candidateId: CANDIDATE, jobId: JOB,
    jobVersionId: JOB_VERSION, resumeVersionId: 'same-version',
  })
  assert.equal(result.action, 'REUSED')
  assert.equal(result.stage_code, 'S7', '复用不得改阶段')
  assert.equal(calls.filter((call) => call.sql.trim().toLowerCase().startsWith('update')).length, 0)
})

test('申请：没有 ACTIVE → CREATED', async () => {
  const { client } = fakeClient({ activeRows: [] })
  const result = await ensureActiveApplication(client, {
    tenantId: TENANT, candidateId: CANDIDATE, jobId: JOB,
    jobVersionId: JOB_VERSION, resumeVersionId: 'v1',
  })
  assert.equal(result.action, 'CREATED')
  assert.equal(result.id, 'new-app')
})

test('申请：INSERT 撞 23505（0009 部分唯一索引/并发）→ 回读那条 ACTIVE 当 REUSED', async () => {
  const duplicate = Object.assign(new Error('duplicate key value violates unique constraint "uq_application_active_cycle"'), {
    code: '23505',
  })
  const { client, calls } = fakeClient({
    activeRows: [
      null, // 第一次 select：没有（否则不会走到 insert）
      {
        id: 'raced-app', record_version: 1, stage_code: 'S6', lifecycle_status: 'ACTIVE',
        job_version_id: JOB_VERSION, resume_version_id: 'raced-version',
      },
    ],
    insertError: duplicate,
    updatedRow: {
      id: 'raced-app', record_version: 3, stage_code: 'S6', lifecycle_status: 'ACTIVE',
      job_version_id: JOB_VERSION, resume_version_id: 'v2',
    },
  })
  const result = await ensureActiveApplication(client, {
    tenantId: TENANT, candidateId: CANDIDATE, jobId: JOB,
    jobVersionId: JOB_VERSION, resumeVersionId: 'v2',
  })
  assert.equal(result.action, 'REUSED', '23505 必须被当成"别人先建了"，而不是失败')
  assert.equal(result.id, 'raced-app')
  assert.equal(result.resume_version_id, 'v2')
  assert.equal(calls.filter((call) => call.sql.includes('insert into recruitment.application')).length, 1)
})

test('申请：INSERT 的非 23505 错误必须原样抛出（不吞错）', async () => {
  const { client } = fakeClient({
    activeRows: [],
    insertError: Object.assign(new Error('boom'), { code: '23503' }),
  })
  await assert.rejects(
    ensureActiveApplication(client, {
      tenantId: TENANT, candidateId: CANDIDATE, jobId: JOB,
      jobVersionId: JOB_VERSION, resumeVersionId: 'v1',
    }),
    /boom/,
  )
})

test('findActiveApplication：只按 (candidate, job, ACTIVE) 查，sql 里没有 sha', async () => {
  const { client, calls } = fakeClient({ activeRows: [] })
  assert.equal(await findActiveApplication(client, TENANT, CANDIDATE, JOB), null)
  const sql = (calls[0] as FakeCall).sql
  assert.match(sql, /lifecycle_status = 'ACTIVE'/)
  assert.match(sql, /candidate_id = \$2/)
  assert.doesNotMatch(sql, /sha256/)
})
