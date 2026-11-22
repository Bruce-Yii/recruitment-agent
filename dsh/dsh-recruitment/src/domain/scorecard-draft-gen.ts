// G-06：转写成功入库后，为「尚未提交面评且尚无草稿」的面试官生成一份**待核对面评草稿**。
//
// 边界（硬约束，改动本文件前先读）：
//   * 只写 `recruitment.scorecard_draft`（append-only），**绝不**碰 `recruitment.scorecard`
//     的任何写路径，也绝不调用 scorecard-submit。本文件没有任何 SUBMITTED/WAIVED 写入。
//   * 纯函数 `generateScorecardDraft()` 只按申请钉住的 rubric 维度 + 转写原文产出 payload；
//     不编造转写里没有的事实，无法判定的维度一律给 `NOT_OBSERVED`（待核对），备注首行固定。
//   * 自动草稿失败是**可降级事件**：调用方（`transcript-import`）只记日志、转写工具仍返回成功，
//     且草稿写用 savepoint 隔离，失败只回滚草稿写，绝不回滚已经成功的转写入库。
//   * 任何已存在草稿（人工或此前自动生成的）都跳过；已提交 / 已豁免面评的面试官也跳过。
//
// 与 `src/db/scorecard-draft.ts` 的关系：只 import 它的 `readDraft/saveDraft/validateDraftPayload`，
// 不修改它；payload 形状沿用 `{assessments?: {criterion_key: value}, note?: string}`。
// ---------------------------------------------------------------------------
import type { DatabaseClient } from '../db/pool.ts'
import { readDraft, saveDraft, validateDraftPayload } from '../db/scorecard-draft.ts'

/** 草稿备注的首行（逐字固定；HR 会读到，禁用工程话术）。 */
export const AUTO_DRAFT_NOTE_FIRST_LINE = '以下为基于面试转写生成的参考草稿，请面试官核对并自行决定评价'

/** 待核对维度使用的 assessment 值（来自面评四态闭集，不编造 MET / NOT_MET）。 */
export const AUTO_DRAFT_ASSESSMENT = 'NOT_OBSERVED'

/** savepoint 名（固定；本工具一次调用只有一个事务、一个自动草稿阶段）。 */
const SAVEPOINT = 'auto_scorecard_draft_write'

/** 日志接口（宿主可注入；缺省用 console.warn，保证失败一定留下日志）。 */
export interface AutoDraftLogger {
  warn(message: string): void
}

/** 一条 rubric 维度（只取 key / label，缺 label 用 key，不编造）。 */
export interface RubricDimension {
  readonly key: string
  readonly label?: string
}

/** 纯函数入参。 */
export interface GenerateScorecardDraftInput {
  readonly rubricDimensions: readonly RubricDimension[]
  /** 转写正文（来自已落库的 artifact.raw_text）；为空时无法生成有内容的草稿。 */
  readonly transcriptText: string
}

/** 生成结果（含是否没有可用转写，供调用方决定是否落库）。 */
export interface GeneratedDraft {
  readonly payload: Record<string, unknown>
  /** true = 转写正文为空/不可读，只产出空 assessments（调用方应跳过落库）。 */
  readonly noTranscript: boolean
}

/** 把维度 label 收敛成一行短文本（带 key，供面试官逐项核对；去掉换行避免撑成多行结构）。 */
function safeLabel(dimension: RubricDimension): string {
  const label = typeof dimension.label === 'string' && dimension.label.trim() !== ''
    ? dimension.label.replace(/\s+/g, ' ').trim().slice(0, 80)
    : ''
  const key = dimension.key.replace(/\s+/g, ' ').trim().slice(0, 80)
  return label === '' || label === key ? key : `${label}（${key}）`
}

/**
 * 纯函数：按 pinned rubric 维度 + 转写原文生成待核对草稿 payload。
 *
 * 规则：
 *   1. 备注首行恒为 `AUTO_DRAFT_NOTE_FIRST_LINE`；
 *   2. 每个合法维度一条 assessment=`NOT_OBSERVED`（不编造转写里没写出的判断），
 *      key 集合恰好等于 rubric 维度 key 集合（重复 key 去重，保持原顺序）；
 *   3. 备注其余行只列**来自 rubric 的真实维度 label/key**与「请对照本场转写核对」的提示，
 *      绝不写「证据」二字，也绝不把转写片段原样搬进备注（避免把转写里的措辞当我们的文案）；
 *   4. 转写正文为空 → `noTranscript=true`、assessments 为空（调用方跳过落库，不写空草稿）；
 *   5. 只产出 DB 适配器接受的形状，随后由 `validateDraftPayload` 再做一次前置校验。
 * @param input - 维度列表 + 转写正文。
 */
export function generateScorecardDraft(input: GenerateScorecardDraftInput): GeneratedDraft {
  const transcriptText = typeof input.transcriptText === 'string' ? input.transcriptText : ''
  const noTranscript = transcriptText.trim() === ''

  const dimensions: RubricDimension[] = []
  const seen = new Set<string>()
  for (const raw of input.rubricDimensions ?? []) {
    const key = typeof raw?.key === 'string' ? raw.key.trim() : ''
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    dimensions.push({ key, ...(typeof raw.label === 'string' ? { label: raw.label } : {}) })
  }

  const assessments: Record<string, string> = {}
  if (!noTranscript) {
    for (const dimension of dimensions) assessments[dimension.key] = AUTO_DRAFT_ASSESSMENT
  }

  const lines: string[] = [AUTO_DRAFT_NOTE_FIRST_LINE]
  if (noTranscript) {
    lines.push('本场转写正文暂不可用，未生成逐项参考值；请面试官在转写就绪后自行填写。')
  } else {
    lines.push('以下逐项均为待核对状态，请对照本场面试转写自行判断是否采纳或修改。')
    if (dimensions.length > 0) {
      lines.push(`待核对维度（${String(dimensions.length)}）：${dimensions.map(safeLabel).join('、')}`)
    }
  }
  const payload = validateDraftPayload({ assessments, note: lines.join('\n') })
  return { payload, noTranscript }
}

/** 解析 `rubric_version.dimensions`（pg jsonb 通常已解析；字符串时再 JSON.parse 一次）。 */
export function parseRubricDimensions(value: unknown): RubricDimension[] {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  const out: RubricDimension[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const raw = entry as Record<string, unknown>
    if (typeof raw.key !== 'string' || raw.key.trim() === '') continue
    out.push({
      key: raw.key.trim(),
      ...(typeof raw.label === 'string' && raw.label.trim() !== '' ? { label: raw.label } : {}),
    })
  }
  return out
}

/** 该场面试的候选面试官（必填面评 + HUMAN + ACTIVE；只读身份，不是权限判定）。 */
const ELIGIBLE_INTERVIEWERS_SQL = `
  select ivr.id::text as interviewer_id,
         ivr.actor_id::text as interviewer_actor_id
    from recruitment.interviewer ivr
    join recruitment.actor ac
      on ac.id = ivr.actor_id and ac.tenant_id = ivr.tenant_id
   where ivr.tenant_id = $1 and ivr.interview_id = $2
     and ivr.required_scorecard = true
     and ac.kind = 'HUMAN' and ac.status = 'ACTIVE'
   order by ivr.id
`

/** 当前面评状态（只取未 revisions 的当前行；与 `assertDraftWritable` 同一口径）。 */
const CURRENT_SCORECARD_SQL = `
  select status
    from recruitment.scorecard
   where tenant_id = $1 and interview_id = $2 and interviewer_id = $3
     and superseded_by_scorecard_id is null
`

/** 钉住版本的 rubric 维度。 */
const RUBRIC_DIMENSIONS_SQL = `
  select dimensions
    from recruitment.rubric_version
   where tenant_id = $1 and id = $2
`

type QueryableClient = Pick<DatabaseClient, 'query'>

interface EligibleInterviewerRow {
  readonly interviewer_id: string
  readonly interviewer_actor_id: string
}

/** 自动草稿编排入参（身份全部由调用方从服务端上下文传入，不接受模型入参）。 */
export interface AutoDraftParams {
  readonly tenantId: string
  readonly interviewId: string
  readonly applicationId: string
  readonly rubricVersionId: string | null
  /** rubric 是否属于该申请的岗位（transcript-import 的左连已判定）；false 时不生成。 */
  readonly rubricJobOk: boolean
  readonly transcriptText: string
  readonly logger?: AutoDraftLogger
}

/** 一次自动草稿的结果（调用方不回显，只用于测试与日志）。 */
export interface AutoDraftOutcome {
  readonly generated: number
  readonly skipped: number
  readonly reasons: readonly string[]
  readonly failed: boolean
}

const NOOP_LOGGER: AutoDraftLogger = { warn: () => {} }

/**
 * 只读判定当前面评是否已提交/已豁免（不抛错；异常由上层 catch 隔离）。
 * @returns `SUBMITTED` / `WAIVED` 表示必须跳过；其它（含无行）可写草稿。
 */
async function currentScorecardStatus(
  client: QueryableClient,
  tenantId: string,
  interviewId: string,
  interviewerId: string,
): Promise<string | undefined> {
  const { rows } = await client.query<{ status: string }>(CURRENT_SCORECARD_SQL, [
    tenantId, interviewId, interviewerId,
  ])
  return rows[0]?.status
}

/**
 * 转写成功入库后调用：为每个符合条件的面试官追加一行自动草稿（append-only）。
 *
 * 失败隔离：
 *   * 整个函数在 `try` 里跑；任何异常都先 `ROLLBACK TO SAVEPOINT`（只撤销草稿写，
 *     保留调用方事务里已经完成的转写写入），再 `logger.warn` 并返回 `failed=true`，**不抛**；
 *   * 每个面试官的「已提交/已有草稿」跳过都是正常路径，不计失败；
 *   * 只写 `scorecard_draft`，从不写 `scorecard`。
 * @param client - 调用方事务内的客户端（与转写同事务，savepoint 隔离）。
 * @param params - 服务端派生的身份与 rubric / 转写信息。
 */
export async function tryGenerateAutoDraft(
  client: QueryableClient,
  params: AutoDraftParams,
): Promise<AutoDraftOutcome> {
  const log = params.logger ?? (typeof console !== 'undefined' && typeof console.warn === 'function'
    ? { warn: (message: string) => console.warn(message) }
    : NOOP_LOGGER)
  const reasons: string[] = []
  let generated = 0
  let skipped = 0
  let savepointReady = false

  try {
    await client.query(`SAVEPOINT ${SAVEPOINT}`)
    savepointReady = true

    // 申请没钉 rubric / rubric 不属于该岗位 / 没有转写正文 → 没有任何依据，零草稿。
    if (params.rubricVersionId === null || params.rubricJobOk !== true) {
      reasons.push('no_pinned_rubric')
      return { generated, skipped, reasons, failed: false }
    }
    if (typeof params.transcriptText !== 'string' || params.transcriptText.trim() === '') {
      reasons.push('no_transcript')
      return { generated, skipped, reasons, failed: false }
    }

    const rubricRows = await client.query<{ dimensions: unknown }>(RUBRIC_DIMENSIONS_SQL, [
      params.tenantId, params.rubricVersionId,
    ])
    const dimensions = parseRubricDimensions(rubricRows.rows[0]?.dimensions)
    if (dimensions.length === 0) {
      reasons.push('no_dimensions')
      return { generated, skipped, reasons, failed: false }
    }

    const { payload, noTranscript } = generateScorecardDraft({
      rubricDimensions: dimensions,
      transcriptText: params.transcriptText,
    })
    if (noTranscript) {
      reasons.push('no_transcript')
      return { generated, skipped, reasons, failed: false }
    }

    const rows = await client.query<EligibleInterviewerRow>(ELIGIBLE_INTERVIEWERS_SQL, [
      params.tenantId, params.interviewId,
    ])
    for (const interviewer of rows.rows) {
      const status = await currentScorecardStatus(
        client, params.tenantId, params.interviewId, interviewer.interviewer_id,
      )
      if (status === 'SUBMITTED' || status === 'WAIVED') {
        skipped += 1
        reasons.push(`scorecard_${status.toLowerCase()}`)
        continue
      }
      // 任何已存在草稿（人工或此前自动生成的）都跳过：绝不覆盖。
      const existing = await readDraft(
        client as DatabaseClient, params.tenantId, params.interviewId, interviewer.interviewer_actor_id,
      )
      if (existing !== null) {
        skipped += 1
        reasons.push('draft_exists')
        continue
      }
      await saveDraft(client as DatabaseClient, {
        tenant_id: params.tenantId,
        interview_id: params.interviewId,
        interviewer_id: interviewer.interviewer_id,
        interviewer_actor_id: interviewer.interviewer_actor_id,
        payload,
      })
      generated += 1
    }
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`)
    return { generated, skipped, reasons, failed: false }
  } catch (error) {
    if (savepointReady) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`)
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`)
      } catch {
        // 回滚 savepoint 本身失败也必须吞掉：转写写在前，不能被草稿失败带回滚。
      }
    }
    const name = error instanceof Error ? error.name : typeof error
    log.warn(`auto-scorecard-draft: 生成失败已隔离（转写写入不受影响） error=${name}`)
    return { generated: 0, skipped, reasons: [...reasons, 'failed'], failed: true }
  }
}
