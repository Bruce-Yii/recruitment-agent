// 必交面评（required scorecard）进度的**唯一派生实现**（O14）。
//
// 为什么单独成文件：同一个业务事实（"这场面试要交几份、交了几份"）原来在两处各算一次 ——
//   * `recruitment_interview_get` 按面试官集合算（R1 required=1 / R2 required=2，合计 3）；
//   * `recruitment_application_get` 却按 `scorecard` 行数算（0/0），两边口径不一致。
// 两处各写一遍 SQL/循环 = 漂移的起点（和 transcript.state 的 C-4 事故同构）。这里只放纯函数，
// 两个工具都 import 它：`required` / `submitted` / `waived` / `pending` 的定义只有一份。
//
// 口径（与 `interview-get.ts` 原有实现逐条一致，抽取时未改语义）：
//   * `required` = `required_scorecard=true` 的**面试官行**数（不是面评行数）；
//   * `submitted` / `waived` 只数上述 required 面试官的**当前**面评
//     （`superseded_by_scorecard_id is null`；调用方负责只传当前面评）；
//   * `pending = max(0, required - submitted - waived)`（三者恒满足 required = submitted + waived + pending）。
//
// 纯函数、不碰 DB、不依赖任何具体工具文件（避免工具间循环 import）。

/** 派生的输入之一：一条面试官分配（只取判定所需的两列）。 */
export interface ScorecardInterviewerRow {
  /** `recruitment.interviewer.id`（面评行的 `interviewer_id` 指向它）。 */
  readonly interviewer_id: string
  /** 是否必须交面评（`interviewer.required_scorecard`）。 */
  readonly required_scorecard: boolean
}

/** 派生的输入之二：一条**当前**面评（`superseded_by_scorecard_id is null`）。 */
export interface CurrentScorecardRow {
  readonly interviewer_id: string
  /** PENDING / SUBMITTED / WAIVED。 */
  readonly status: string
}

/** 一场面试（或跨轮汇总）的必交面评进度。 */
export interface RequiredScorecardProgress {
  /** 必交面评的面试官数（跨轮汇总时 = 各轮之和）。 */
  readonly required: number
  /** 其中已提交（SUBMITTED）的份数。 */
  readonly submitted: number
  /** 其中已豁免（WAIVED）的份数。 */
  readonly waived: number
  /** 还差几份（`required - submitted - waived`，不小于 0）。 */
  readonly pending: number
}

/**
 * 派生必交面评进度。
 * @param interviewers - 面试官分配行（可跨轮/跨面试，直接相加）。
 * @param scorecards - **当前**面评行（调用方保证已过滤 superseded）。
 * @returns `{required, submitted, waived, pending}`。
 */
export function deriveRequiredScorecardProgress(
  interviewers: readonly ScorecardInterviewerRow[],
  scorecards: readonly CurrentScorecardRow[],
): RequiredScorecardProgress {
  const requiredInterviewerIds = new Set(
    interviewers.filter((row) => row.required_scorecard).map((row) => row.interviewer_id),
  )
  let submitted = 0
  let waived = 0
  for (const row of scorecards) {
    // 计数只数 `required_scorecard=true` 的面试官 —— 否则"非 required 的面试官交了评、
    // required 的没交"会出现 pending=0 却仍有 SCORECARD_PENDING 的自相矛盾。
    if (!requiredInterviewerIds.has(row.interviewer_id)) continue
    if (row.status === 'SUBMITTED') submitted += 1
    else if (row.status === 'WAIVED') waived += 1
  }
  const required = requiredInterviewerIds.size
  return { required, submitted, waived, pending: Math.max(0, required - submitted - waived) }
}
