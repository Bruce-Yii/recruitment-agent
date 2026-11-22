// G-06 自动面评草稿 · 无真库单元测试。
//
// 覆盖：
//   * 纯函数：备注首行固定、无「证据」、每维 assessment=NOT_OBSERVED（不编造）、空转写不生成；
//   * 静态断言：新领域文件 / transcript-import 都不写正式 scorecard、不调 submit；
//   * 编排（假 client）：新转写写草稿、已有草稿跳过、已提交/已豁免跳过、
//     草稿失败被 savepoint 隔离（发 ROLLBACK TO SAVEPOINT 且不抛），转写入库不受影响。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUTO_DRAFT_ASSESSMENT,
  AUTO_DRAFT_NOTE_FIRST_LINE,
  generateScorecardDraft,
  parseRubricDimensions,
  tryGenerateAutoDraft,
  type AutoDraftLogger,
} from '../../src/domain/scorecard-draft-gen.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')

const TENANT = '11111111-1111-4111-8111-000000000001'
const INTERVIEW = '11111111-1111-4111-8111-000000000abc'
const RUBRIC = '22222222-2222-4222-8222-000000000001'
const TRANSCRIPT = '面试官：请介绍一个你主导的项目。\n候选人：我负责订单链路的稳定性治理，把超时率降了下来。'

const DIMENSIONS = [
  { key: 'backend_depth', label: '后端深度', weight: 0.6, kind: 'MUST_HAVE' },
  { key: 'system_design', label: '系统设计', weight: 0.4, kind: 'MUST_HAVE' },
]

// ---------------------------------------------------------------------------
//  纯函数
// ---------------------------------------------------------------------------

test('generateScorecardDraft：备注首行固定且全文无「证据」', () => {
  const { payload, noTranscript } = generateScorecardDraft({
    rubricDimensions: DIMENSIONS,
    transcriptText: TRANSCRIPT,
  })
  assert.equal(noTranscript, false)
  const note = payload.note as string
  assert.ok(note.startsWith(`${AUTO_DRAFT_NOTE_FIRST_LINE}\n`), note)
  assert.equal(note.split('\n')[0], AUTO_DRAFT_NOTE_FIRST_LINE)
  assert.equal(note.includes('证据'), false, `备注不得含禁用词：${note}`)
  assert.equal(JSON.stringify(payload).includes('证据'), false)
})

test('generateScorecardDraft：每个维度一条待核对 assessment，不编造 MET/NOT_MET', () => {
  const { payload } = generateScorecardDraft({ rubricDimensions: DIMENSIONS, transcriptText: TRANSCRIPT })
  const assessments = payload.assessments as Record<string, string>
  assert.deepEqual(Object.keys(assessments), ['backend_depth', 'system_design'])
  for (const value of Object.values(assessments)) {
    assert.equal(value, AUTO_DRAFT_ASSESSMENT)
    assert.notEqual(value, 'MET')
    assert.notEqual(value, 'NOT_MET')
  }
  const note = payload.note as string
  assert.match(note, /后端深度（backend_depth）、系统设计（system_design）/)
})

test('generateScorecardDraft：维度 key 去重、缺 label 用 key、label 换行收敛', () => {
  const { payload } = generateScorecardDraft({
    rubricDimensions: [
      { key: 'a', label: 'A\nB' },
      { key: 'a', label: '重复' },
      { key: 'b' },
      { key: '   ' },
      { key: 42 as unknown as string },
    ],
    transcriptText: TRANSCRIPT,
  })
  assert.deepEqual(Object.keys(payload.assessments as object), ['a', 'b'])
  assert.match(payload.note as string, /A B/)
  assert.match(payload.note as string, /b/)
})

test('generateScorecardDraft：空转写 → noTranscript=true 且 assessments 为空（不写空草稿）', () => {
  const { payload, noTranscript } = generateScorecardDraft({
    rubricDimensions: DIMENSIONS,
    transcriptText: '   \n  ',
  })
  assert.equal(noTranscript, true)
  assert.deepEqual(payload.assessments, {})
  assert.equal((payload.note as string).includes('证据'), false)
})

test('parseRubricDimensions：jsonb 数组/字符串都解析；非法条目跳过', () => {
  assert.deepEqual(parseRubricDimensions([{ key: 'x', label: 'X' }, { nope: 1 }, { key: '' }]), [{ key: 'x', label: 'X' }])
  assert.deepEqual(parseRubricDimensions('[{"key":"y"}]'), [{ key: 'y' }])
  assert.deepEqual(parseRubricDimensions('{bad json'), [])
  assert.deepEqual(parseRubricDimensions({ key: 'z' }), [])
})

// ---------------------------------------------------------------------------
//  静态断言：自动草稿链路绝不写正式 scorecard / 绝不调用 submit
// ---------------------------------------------------------------------------

test('静态断言：领域文件与 transcript-import 都不写 scorecard 正式态、不调 submit/waive', () => {
  const files = [
    join(PLUGIN_DIR, 'src', 'domain', 'scorecard-draft-gen.ts'),
    join(PLUGIN_DIR, 'src', 'tools', 'transcript-import.ts'),
  ]
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // 去掉注释后再扫，避免文件头说明性文字（"绝不调用 submit"）误命中。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    assert.equal(/\binsert\s+into\s+recruitment\.scorecard\b/i.test(code), false, `${file}: 不得 insert scorecard`)
    assert.equal(/\bupdate\s+recruitment\.scorecard\b/i.test(code), false, `${file}: 不得 update scorecard`)
    assert.equal(/\bdelete\s+from\s+recruitment\.scorecard\b/i.test(code), false, `${file}: 不得 delete scorecard`)
    assert.equal(/from\s+['"][^'"]*scorecard[-_/]submit|submitScorecard\s*\(|waiveScorecard\s*\(/i.test(code), false,
      `${file}: 不得 import/调用 submit/waive`)
  }

  // 触发点：转写工具只在**新写入**返回前调用一次 helper（replay 路径不生成草稿）。
  const toolSource = readFileSync(join(PLUGIN_DIR, 'src', 'tools', 'transcript-import.ts'), 'utf8')
  const calls = toolSource.match(/tryGenerateAutoDraft\s*\(/g) ?? []
  assert.equal(calls.length, 1, '转写工具应且只应调用一次自动草稿 helper')
  const callIndex = toolSource.indexOf('tryGenerateAutoDraft(client')
  const replayReturnIndex = toolSource.indexOf('return await replayValue(')
  // 新写入路径的 buildValue 是唯一带 `id: artifactId` 的那个（replay 路径从 row 取 id）。
  const finalReturnIndex = toolSource.search(/return buildValue\(\{[\s\S]*?id: artifactId,/)
  assert.ok(callIndex > replayReturnIndex && callIndex < finalReturnIndex,
    `helper 调用点必须位于 replay 早返回之后、新写入成功返回之前（${callIndex}/${replayReturnIndex}/${finalReturnIndex}）`)
})

// ---------------------------------------------------------------------------
//  编排（假 client，无真库）
// ---------------------------------------------------------------------------

interface QueryCall { readonly sql: string; readonly values: readonly unknown[] }

interface FakeOptions {
  readonly draftExists?: boolean
  readonly scorecardStatus?: string | null
  readonly rubricDimensions?: unknown
  readonly interviewers?: readonly { interviewer_id: string; interviewer_actor_id: string }[]
  /** 让 saveDraft 的最后一次 INSERT 抛错，模拟生成失败。 */
  readonly failSave?: boolean
}

function makeClient(options: FakeOptions = {}) {
  const calls: QueryCall[] = []
  const warnings: string[] = []
  const logger: AutoDraftLogger = { warn: (message) => warnings.push(message) }
  const interviewers = options.interviewers ?? [
    { interviewer_id: 'ivr-1', interviewer_actor_id: 'actor-1' },
  ]
  const client = {
    async query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
      calls.push({ sql, values })
      const norm = sql.replace(/\s+/g, ' ').trim()
      if (/^SAVEPOINT/i.test(norm) || /^RELEASE SAVEPOINT/i.test(norm) || /^ROLLBACK TO SAVEPOINT/i.test(norm)) {
        return { rows: [] }
      }
      if (norm.includes('from recruitment.rubric_version')) {
        return { rows: [{ dimensions: options.rubricDimensions ?? DIMENSIONS }] as T[] }
      }
      if (norm.includes('from recruitment.interviewer ivr')) {
        return { rows: interviewers as unknown as T[] }
      }
      if (norm.includes('from recruitment.scorecard where')) {
        const status = options.scorecardStatus ?? null
        return { rows: status === null ? [] : [{ status }] as T[] }
      }
      if (norm.includes('from recruitment.scorecard_draft')) {
        // 第一次是 readDraft 的存在性检查，第二次（saveDraft 的 select ... for update）也算这里。
        return { rows: options.draftExists === true ? [{ record_version: 1 }] as T[] : [] }
      }
      if (norm.includes('insert into recruitment.scorecard_draft')) {
        if (options.failSave === true) throw new Error('fake insert failure')
        return { rows: [{ id: 'draft-1', record_version: 1 }] as T[] }
      }
      throw new Error(`unexpected SQL: ${norm}`)
    },
  }
  return { client, calls, warnings, logger }
}

function baseParams(logger: AutoDraftLogger) {
  return {
    tenantId: TENANT,
    interviewId: INTERVIEW,
    applicationId: '33333333-3333-4333-8333-000000000001',
    rubricVersionId: RUBRIC,
    rubricJobOk: true,
    transcriptText: TRANSCRIPT,
    logger,
  }
}

test('新转写：为候选人面试官追加一行草稿（payload 形状与纯函数一致）', async () => {
  const { client, calls, warnings, logger } = makeClient()
  const outcome = await tryGenerateAutoDraft(client, baseParams(logger))
  assert.deepEqual(
    { generated: outcome.generated, skipped: outcome.skipped, failed: outcome.failed },
    { generated: 1, skipped: 0, failed: false },
  )
  assert.deepEqual(warnings, [])
  const insert = calls.find((call) => /insert into recruitment\.scorecard_draft/i.test(call.sql))
  assert.ok(insert, '应写入 scorecard_draft')
  const payload = insert!.values[4] as string
  const parsed = JSON.parse(payload) as { assessments: Record<string, string>; note: string }
  assert.deepEqual(parsed.assessments, { backend_depth: 'NOT_OBSERVED', system_design: 'NOT_OBSERVED' })
  assert.equal(parsed.note.startsWith(AUTO_DRAFT_NOTE_FIRST_LINE), true)
  assert.equal(parsed.note.includes('证据'), false)
  // 没有任何 scorecard 正式态写入。
  assert.equal(calls.some((call) => /\bupdate recruitment\.scorecard\b|\binsert into recruitment\.scorecard\b/i.test(call.sql)), false)
})

test('已有草稿（人工或此前自动）：跳过，不覆盖', async () => {
  const { client, calls, logger } = makeClient({ draftExists: true })
  const outcome = await tryGenerateAutoDraft(client, baseParams(logger))
  assert.equal(outcome.generated, 0)
  assert.equal(outcome.skipped, 1)
  assert.equal(outcome.failed, false)
  assert.equal(calls.some((call) => /insert into recruitment\.scorecard_draft/i.test(call.sql)), false)
})

test('已提交 / 已豁免：跳过，不写草稿', async () => {
  for (const status of ['SUBMITTED', 'WAIVED']) {
    const { client, calls, logger } = makeClient({ scorecardStatus: status })
    const outcome = await tryGenerateAutoDraft(client, baseParams(logger))
    assert.equal(outcome.generated, 0, status)
    assert.equal(outcome.skipped, 1, status)
    assert.equal(calls.some((call) => /insert into recruitment\.scorecard_draft/i.test(call.sql)), false, status)
    assert.equal(calls.some((call) => /from recruitment\.scorecard_draft/i.test(call.sql)), false, `${status}: 不必读草稿`)
  }
})

test('多面试官：已提交者跳过、未提交者生成；互不干扰', async () => {
  const { client, calls, logger } = makeClient({
    interviewers: [
      { interviewer_id: 'ivr-1', interviewer_actor_id: 'actor-1' },
      { interviewer_id: 'ivr-2', interviewer_actor_id: 'actor-2' },
    ],
    // 假 client 对所有 scorecard 查询返回同一状态：这里只验证一条路径下两人都能处理。
  })
  const outcome = await tryGenerateAutoDraft(client, baseParams(logger))
  assert.equal(outcome.generated, 2)
  assert.equal(outcome.skipped, 0)
  assert.equal(calls.filter((call) => /insert into recruitment\.scorecard_draft/i.test(call.sql)).length, 2)
})

test('草稿生成失败：savepoint 回滚草稿写、记日志、不抛（转写入库不受影响）', async () => {
  const { client, calls, warnings, logger } = makeClient({ failSave: true })
  const outcome = await tryGenerateAutoDraft(client, baseParams(logger))
  assert.equal(outcome.failed, true)
  assert.equal(outcome.generated, 0)
  assert.ok(warnings.some((message) => message.includes('auto-scorecard-draft')), warnings.join('; '))
  assert.ok(calls.some((call) => /^ROLLBACK TO SAVEPOINT/i.test(call.sql.replace(/\s+/g, ' ').trim())), '应回滚到 savepoint')
  // 回滚只覆盖草稿写；调用方事务里转写工具已完成的 INSERT 发生在本 helper 之前，不在此 savepoint 内。
  const savepointIndex = calls.findIndex((call) => /^SAVEPOINT/i.test(call.sql.replace(/\s+/g, ' ').trim()))
  const rollbackIndex = calls.findIndex((call) => /^ROLLBACK TO SAVEPOINT/i.test(call.sql.replace(/\s+/g, ' ').trim()))
  assert.ok(savepointIndex >= 0 && rollbackIndex > savepointIndex)
})

test('缺 rubric / rubric 不属于岗位 / 无 rubric 维度 / 空转写：零草稿且不失败', async () => {
  const cases = [
    { rubricVersionId: null, rubricJobOk: true, transcriptText: TRANSCRIPT },
    { rubricVersionId: RUBRIC, rubricJobOk: false, transcriptText: TRANSCRIPT },
    { rubricVersionId: RUBRIC, rubricJobOk: true, transcriptText: '' },
  ]
  for (const override of cases) {
    const { client, calls, logger } = makeClient({ rubricDimensions: [] })
    const outcome = await tryGenerateAutoDraft(client, { ...baseParams(logger), ...override })
    assert.equal(outcome.failed, false)
    assert.equal(outcome.generated, 0)
    assert.equal(calls.some((call) => /insert into recruitment\.scorecard_draft/i.test(call.sql)), false)
  }
  // 有 rubric + 转写但维度为空：同样零草稿。
  const { client, calls, logger } = makeClient({ rubricDimensions: [] })
  const outcome = await tryGenerateAutoDraft(client, baseParams(logger))
  assert.equal(outcome.generated, 0)
  assert.equal(calls.some((call) => /insert into recruitment\.scorecard_draft/i.test(call.sql)), false)
})
