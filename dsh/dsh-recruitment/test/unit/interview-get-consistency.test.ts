// C-4 回归闸门（**不连库**）：`recruitment_interview_get` 必须复用 `transcript-read.ts`
// 的**唯一**派生实现，而不是自己再写一套 TR-D。
//
// 事故（G3 报告 C-4）：`interview-get.ts` 曾自写 `deriveTranscript()` + `mapCanonicalStatus()`
// + 本地 `TranscriptState`/`TranscriptReasonCode`；`transcript-read.ts` 已有权威
// `deriveTranscriptState()`（D-96/TR-F4：canonical 状态 READY 但 `raw_text` 为空时，
// 必须报 `PARTIAL/ARTIFACT_EMPTY`，不得报 READY）。两套实现漂移后，**同一条 DB 事实**
// 在两个工具里给出不同的 `transcript.state`/`reason_code`。
//
// 本文件守四件事（都能在 CI 无库环境下跑）：
//   1. 源码层：只有 import + re-export，没有本地派生函数/本地类型/本地 map；
//   2. schema 层：`reason_code` enum 含 `ARTIFACT_EMPTY`，且与 transcript_read 的 enum 逐一相等；
//   3. 行为锚：直接调权威函数，空正文 → `PARTIAL/ARTIFACT_EMPTY`（interview_get 现在调的就是它）；
//   4. 只读：`interview-get.ts` 的 SQL 模板里没有任何写语句。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { createInterviewGetTool } from '../../src/tools/interview-get.ts'
import { createTranscriptReadTool, deriveTranscriptState } from '../../src/tools/transcript-read.ts'

/** `src/tools` 目录（源码守卫读文件用）。 */
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools')
const INTERVIEW_GET_SOURCE = readFileSync(join(TOOL_DIR, 'interview-get.ts'), 'utf8')

/** 配置只用于构造工具；本文件不连库，密码是占位值。 */
const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved

if (DATABASE === null) throw new Error('测试配置解析失败')

/** TR-D §4 的七个 state（封闭集，C-4 前后都不许变）。 */
const TR_D_STATES = [
  'MISSING', 'PENDING', 'READY', 'PARTIAL', 'AUTH_REQUIRED', 'NEEDS_LINKING', 'RETRYABLE_FAILED',
] as const

/** TR-D §5 的八个 reason_code（含 D-96/TR-F4 的 `ARTIFACT_EMPTY`）。 */
const TR_D_REASON_CODES = [
  'NO_MEETING_BOUND', 'CANONICAL_STATUS', 'READY_NO_CANONICAL', 'ONLY_PARTIAL',
  'ONLY_AUTH_REQUIRED', 'NO_ARTIFACT_AFTER_WAIT', 'WAITING', 'ARTIFACT_EMPTY',
] as const

/**
 * 取 `interview_get` 的 `interviews[] → transcript` 两个 enum。
 * @param schema - 工具的 `output.schema`。
 */
function interviewTranscriptEnums(schema: unknown): { state: string[]; reason_code: string[] } {
  const node = schema as {
    properties: {
      interviews: {
        items: {
          properties: {
            transcript: {
              properties: {
                state: { enum: string[] }
                reason_code: { enum: string[] }
              }
            }
          }
        }
      }
    }
  }
  return {
    state: [...node.properties.interviews.items.properties.transcript.properties.state.enum],
    reason_code: [...node.properties.interviews.items.properties.transcript.properties.reason_code.enum],
  }
}

/**
 * 取 `transcript_read` 的顶层 `transcript` 两个 enum（权威工具的形状）。
 * @param schema - 工具的 `output.schema`。
 */
function transcriptReadEnums(schema: unknown): { state: string[]; reason_code: string[] } {
  const node = schema as {
    properties: {
      transcript: {
        properties: {
          state: { enum: string[] }
          reason_code: { enum: string[] }
        }
      }
    }
  }
  return {
    state: [...node.properties.transcript.properties.state.enum],
    reason_code: [...node.properties.transcript.properties.reason_code.enum],
  }
}

/** 源码里的 SQL 模板字符串（反引号内容；只用来查写语句，不解析 TS）。 */
function sqlLiterals(source: string): string[] {
  return [...source.matchAll(/`([^`]*)`/gs)].map((match) => match[1] as string)
}

// ---------------------------------------------------------------------------
// 1. 禁重复实现守卫（源码层）
// ---------------------------------------------------------------------------

test('禁重复实现：interview_get 只 import transcript-read 的 deriveTranscriptState，没有第二套 TR-D', () => {
  // 必须真的从权威模块 import（不是本地函数、也不是别的文件）。
  assert.match(
    INTERVIEW_GET_SOURCE,
    /import\s*\{[^}]*\bderiveTranscriptState\b[^}]*\}\s*from\s*'\.\/transcript-read\.ts'/s,
    'interview-get.ts 必须 import { deriveTranscriptState } from \'./transcript-read.ts\'',
  )
  // 必须真的调用（import 了不用 = 假接线）。
  assert.match(
    INTERVIEW_GET_SOURCE,
    /const derivation = deriveTranscriptState\(/,
    'interview-get.ts 必须真的调用 deriveTranscriptState()',
  )
  // 类型改为 re-export，公开 API 形状不变；本文件不得再留第二份定义。
  assert.match(
    INTERVIEW_GET_SOURCE,
    /export type \{ TranscriptState, TranscriptReasonCode \} from '\.\/transcript-read\.ts'/,
    'TranscriptState / TranscriptReasonCode 必须从 transcript-read.ts re-export',
  )
  assert.doesNotMatch(INTERVIEW_GET_SOURCE, /export type TranscriptState\s*=/s, '不得在本地重新定义 TranscriptState')
  assert.doesNotMatch(
    INTERVIEW_GET_SOURCE,
    /export type TranscriptReasonCode\s*=/s,
    '不得在本地重新定义 TranscriptReasonCode',
  )
  // 旧的本地派生实现标记必须全部消失（C-4 的核心）。
  for (const marker of [
    'function deriveTranscript(',
    'function mapCanonicalStatus(',
    'interface TranscriptDerivation',
    'readonly reasonCode:',
    'canonicalMissing',
  ]) {
    assert.equal(
      INTERVIEW_GET_SOURCE.includes(marker),
      false,
      `interview-get.ts 仍含本地派生实现标记 ${JSON.stringify(marker)}（C-4 未修完）`,
    )
  }
  // 快照必须带 content_chars，否则权威函数的 ARTIFACT_EMPTY 分支永远走不到。
  assert.match(
    INTERVIEW_GET_SOURCE,
    /content_chars: Number\(artifact\.char_count \?\? 0\)/,
    '组装快照时必须把 char_count 传成 content_chars（D-96/TR-F4 的入口）',
  )
  // SQL 必须真的取正文长度（coalesce 让 NULL 变 0，空串本来就是 0）。
  assert.match(
    INTERVIEW_GET_SOURCE,
    /coalesce\(length\(a\.raw_text\), 0\) as char_count/,
    'artifact 查询必须补 coalesce(length(a.raw_text), 0) as char_count',
  )
  // 产物顺序必须与 transcript_read.ts 的 loadArtifacts() 一致：多场会议各有一个 canonical 时，
  // 权威函数用 `find(is_canonical)` 取第一条，顺序不同就会选中不同 canonical（同一事实两套结果）。
  assert.match(
    INTERVIEW_GET_SOURCE,
    /order by a\.meeting_id, a\.source_revision, a\.variant_type/,
    'artifact 查询必须与 transcript_read 的 loadArtifacts() 同序（canonical 选择才一致）',
  )
  // meetings_total 改为由 M(i) 自身计数（派生函数不再返回这个字段）。
  assert.match(
    INTERVIEW_GET_SOURCE,
    /const meetingsTotal = transcriptMeetings\.length/,
    'meetingsTotal 必须从 transcriptMeetings.length 取',
  )
})

// ---------------------------------------------------------------------------
// 2. schema 守卫：与 transcript_read 的 enum 逐一相等
// ---------------------------------------------------------------------------

test('schema：reason_code enum 含 ARTIFACT_EMPTY，且与 transcript_read 的枚举逐一相等', () => {
  const getEnums = interviewTranscriptEnums(createInterviewGetTool(DATABASE).output.schema)
  const readEnums = transcriptReadEnums(createTranscriptReadTool(DATABASE).output.schema)

  assert.ok(
    getEnums.reason_code.includes('ARTIFACT_EMPTY'),
    `interview_get 的 reason_code enum 缺 ARTIFACT_EMPTY：${JSON.stringify(getEnums.reason_code)}`,
  )
  assert.deepEqual(
    [...getEnums.reason_code].sort(),
    [...TR_D_REASON_CODES].sort(),
    'interview_get 的 reason_code enum 必须与 TR-D §5 封闭集（8 个）一致',
  )
  assert.deepEqual(
    [...getEnums.reason_code].sort(),
    [...readEnums.reason_code].sort(),
    '同一事实的两个工具，reason_code enum 必须逐一相等（C-4）',
  )

  // state 七个取值不变，且与权威工具一致（ARTIFACT_EMPTY 的 state 是 PARTIAL，不是新 state）。
  assert.deepEqual(
    [...getEnums.state].sort(),
    [...TR_D_STATES].sort(),
    'interview_get 的 state enum 必须仍是 TR-D §4 的七个值',
  )
  assert.deepEqual(
    [...getEnums.state].sort(),
    [...readEnums.state].sort(),
    'state enum 必须与 transcript_read 的语义一致',
  )
  assert.equal(getEnums.state.includes('ARTIFACT_EMPTY'), false, 'ARTIFACT_EMPTY 是 reason_code，不是 state')
})

// ---------------------------------------------------------------------------
// 3. 行为锚：权威函数在空正文时的判定（interview_get 现在与它同一函数）
// ---------------------------------------------------------------------------

test('行为锚：canonical READY + 空正文 → PARTIAL/ARTIFACT_EMPTY；有正文 → READY/CANONICAL_STATUS', () => {
  const base = {
    as_of: '2026-11-13T00:00:00+08:00',
    meetings: [{ actual_end_at: '2026-11-10T10:58:00+08:00' }],
    wait_minutes: 120,
  }

  const empty = deriveTranscriptState({
    ...base,
    artifacts: [{ transcript_status: 'READY', is_complete: true, is_canonical: true, content_chars: 0 }],
  })
  assert.equal(empty.state, 'PARTIAL', 'canonical READY 但正文为空时不得报 READY（D-96）')
  assert.equal(empty.reason_code, 'ARTIFACT_EMPTY')

  const withContent = deriveTranscriptState({
    ...base,
    artifacts: [{ transcript_status: 'READY', is_complete: true, is_canonical: true, content_chars: 2379 }],
  })
  assert.equal(withContent.state, 'READY')
  assert.equal(withContent.reason_code, 'CANONICAL_STATUS')
  assert.notDeepEqual(empty, withContent, '“有转写”和“转写为空”必须是两个不同结果')

  // 无 canonical、有 READY+complete → 序 3（interview_get 的 CANONICAL_MISSING 警告仍只认这个）
  const noCanonical = deriveTranscriptState({
    ...base,
    artifacts: [{ transcript_status: 'READY', is_complete: true, is_canonical: false, content_chars: 100 }],
  })
  assert.equal(noCanonical.state, 'READY')
  assert.equal(noCanonical.reason_code, 'READY_NO_CANONICAL')
})

// ---------------------------------------------------------------------------
// 4. 只读：源码里没有任何写语句（运行时另有 `withReadOnly` / DB 25006 兜底）
// ---------------------------------------------------------------------------

test('只读：interview-get.ts 的 SQL 模板不含 insert/update/delete/for update 写语句', () => {
  const sql = sqlLiterals(INTERVIEW_GET_SOURCE).join('\n')
  assert.doesNotMatch(
    sql,
    /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|for\s+update|truncate\s+)\b/i,
    'interview_get 是只读工具：SQL 模板里不得出现写语句',
  )
  assert.match(sql, /select/i, '至少要有 select（否则说明本守卫取错了内容）')
})
