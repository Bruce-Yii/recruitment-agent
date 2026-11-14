// Interviewer Workspace：面试官只看"分配给我的面试 + 本轮工作 + 本人独立面评"。
//
// 一个组件内两屏（列表 ⇄ 详情，不依赖路由）：
//   * 列表：当前分配统计（服务端 counts）+ 分配给我的工作 + 右栏考察重点；
//   * 详情：本轮简报 / 考察重点 / 建议问题 / 授权简历材料 / **两个独立分支**
//     （材料分支 Transcript、面评分支 我的独立评价）+ 右栏面试安排 / 信息可见范围。
//
// 身份：sessionId / alias 只来自 props（绑定是 W0 shell 的职责）；本组件不读也不写
// localStorage、不 PUT actor、不自己推断权限。每次挂载 / sessionId / alias 变化都重新 GET，
// 提交成功后由子组件通知这里重新 GET（服务端事实，不是本地 state）。
//
// 语义红线：
//   1. `interview.status` 只表排期；`transcript` 与 `scorecard` 是两条独立分支，互不推导。
//   2. Transcript 未 READY **不影响**提交面评（服务端记 NO_TRANSCRIPT，D-111）；
//      前端**不判断** S8→S9 / S9→S10 能否推进（G3-B 由服务端阶段闸门负责）。
//   3. 未绑定身份（409 DEMO_ACTOR_UNMAPPED）→ 只显示 fail-closed 提示，不显示任何面试；
//      其它读取失败 → overview-error + code/reason_code，绝不把故障说成"0 条"。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchInterviewerOverview } from './http.ts'
import {
  briefSourceText,
  canSubmitScorecard,
  deriveWorkspaceStats,
  formatSlotRange,
  formatSlotTime,
  groupRounds,
  isBindingPendingError,
  materialFieldEntries,
  meetingBindingStateText,
  RecruitmentHttpError,
  requiredActionText,
  scorecardStateText,
  selectInterview,
  transcriptStateText,
  type InterviewRow,
  type InterviewerOverview,
  type MaterialFieldEntry,
  type RoundFocusGroup,
  type WorkspaceLabels,
  type WorkspaceStats,
} from './normalize.ts'
import { ScorecardForm } from './ScorecardForm.tsx'
import { INTERVIEWER_CSS } from './styles.ts'

/** 视图 props（与 `CLIENT-CONTRACT.md` §2 / `W3-CONTRACT.md` §2.1 一致）。 */
export interface WorkspaceProps {
  /**
   * 当前 DSH Session（W0 shell 给的可能还是 null：重启前 shell 尚未取到/绑定）。
   * null 一律按"未绑定" fail-closed 处理——**不**静默替换成任何默认身份。
   */
  readonly sessionId: string | null
  /** `'recruiter' | 'interviewer_a' | 'interviewer_b'`；null 表示尚未选择演示身份。 */
  readonly alias: string | null
}

/** 读取失败的契约字段。 */
interface ErrorParts {
  readonly code: string
  readonly reasonCode: string
  readonly message: string
  readonly status: number
}

/**
 * 身份绑定竞态的退避序列（毫秒）：W0 shell 先改 alias props、再 await PUT /actor，
 * 服务端 registry 落定前的 403/409 属于可重试时序；7 次约 3.2s，足够覆盖本地 PUT 往返，
 * 又不至于让真正的未绑定错误长时间被 loading 掩盖。
 */
const BINDING_RETRY_DELAYS_MS = [400, 400, 450, 450, 500, 500, 500] as const

/** 把任意错误拆成可展示字段（网络层失败 status=0）。 */
function describeError(failure: unknown): ErrorParts {
  if (failure instanceof RecruitmentHttpError) {
    return {
      code: failure.code,
      reasonCode: failure.reasonCode,
      message: failure.message,
      status: failure.status,
    }
  }
  return {
    code: '',
    reasonCode: '',
    message: failure instanceof Error ? failure.message : String(failure),
    status: 0,
  }
}

/** 候选人头像首字（空名不造字，用 '?' 明确表示"服务端未提供"）。 */
function candidateInitial(displayName: string): string {
  const text = displayName.trim()
  if (text === '') return '?'
  const first = Array.from(text)[0]
  return first === undefined ? '?' : first
}

/** 行状态 chip 的中文（只映射服务端字段，不推断阶段）。 */
function rowStatusText(row: InterviewRow): string {
  if (row.scorecard.state === 'SUBMITTED') return '面评已提交'
  if (row.scorecard.state === 'WAIVED') return '面评已豁免'
  if (row.required_action === 'SUBMIT_SCORECARD') return '待提交面评'
  return requiredActionText(row.required_action)
}

/** 行状态 chip 的颜色（蓝=待我做，绿=已完成，琥珀=已豁免/待定）。 */
function rowStatusClass(row: InterviewRow): string {
  if (row.scorecard.state === 'SUBMITTED') return 'iw-chip-green'
  if (row.scorecard.state === 'WAIVED') return 'iw-chip-amber'
  if (row.required_action === 'SUBMIT_SCORECARD') return 'iw-chip-blue'
  return ''
}

/** 行副标题：岗位 · 轮次目标 · 时间（缺什么就显示"未提供"，不编造）。 */
function rowSummaryText(row: InterviewRow): string {
  const jobText = row.job.title !== '' ? row.job.title : row.job.code !== '' ? row.job.code : '岗位未提供'
  const objective =
    row.brief.objective !== '' ? row.brief.objective : row.brief.source === 'NONE' ? '无本轮简报' : '本轮目标未提供'
  const time = formatSlotTime(row.scheduled_start_at, row.timezone)
  return `${jobText} · ${objective} · ${time !== '' ? time : '待安排'}`
}

/** 授权材料不可用时的说明（服务端 reason 优先，空则给通用事实）。 */
function materialsUnavailableText(row: InterviewRow): string {
  const reason = row.materials.reason
  if (reason !== '') return `材料暂不可用（服务端 reason：${reason}）。`
  if (row.materials.resume !== null) return '材料暂不可用（服务端未给出原因）。'
  return '服务端未绑定可读的简历材料（不展示占位内容）。'
}

/** 打开"提交我的独立面评"的按钮被禁用的原因（说清事实，不给假按钮）。 */
function openScorecardDisabledReason(row: InterviewRow): string {
  if (row.scorecard.state === 'SUBMITTED') return '本轮面评已提交；修订需要服务端 revision 闭环，本版不开放。'
  if (row.scorecard.state === 'WAIVED') return '本轮面评已豁免，不再重复提交。'
  if (row.role_in_interview !== 'INTERVIEWER') return '当前身份不是这场面试的登记面试官，不能提交面评。'
  return '服务端未把该行标记为“待提交面评”，本版不开放提交。'
}

/** 一条列表行（整行可点，进入详情）。 */
function InterviewListItem({
  row,
  onSelect,
}: {
  readonly row: InterviewRow
  readonly onSelect: (interviewId: string) => void
}): JSX.Element {
  const candidateName = row.candidate.display_name !== '' ? row.candidate.display_name : '（候选人未提供）'
  const roundLabel = row.round_no > 0 ? `第 ${row.round_no} 轮` : '轮次未提供'
  return (
    <li>
      <button
        type="button"
        className="iw-appitem"
        data-testid="interviewer-row"
        data-interview-id={row.interview_id}
        data-scorecard-state={row.scorecard.state}
        data-transcript-state={row.transcript.state}
        onClick={() => onSelect(row.interview_id)}
      >
        <span className="iw-av" aria-hidden>
          {candidateInitial(candidateName)}
        </span>
        <span className="iw-rowmain">
          <span className="iw-rowtitle">
            {candidateName}
            <span className="iw-chip iw-chip-blue">{roundLabel}</span>
          </span>
          <span className="iw-rowdesc">{rowSummaryText(row)}</span>
        </span>
        <span className={`iw-chip ${rowStatusClass(row)} iw-rowstate`}>{rowStatusText(row)}</span>
        <span className="iw-chev" aria-hidden>
          ›
        </span>
      </button>
    </li>
  )
}

/** 列表页（V-I1）。 */
function ListView({
  overview,
  stats,
  rounds,
  onSelect,
}: {
  readonly overview: InterviewerOverview
  readonly stats: WorkspaceStats
  readonly rounds: readonly RoundFocusGroup[]
  readonly onSelect: (interviewId: string) => void
}): JSX.Element {
  return (
    <>
      <header className="iw-headline">
        <div className="iw-headline-main">
          <div className="iw-cap">INTERVIEW WORKSPACE</div>
          <h1>我的面试</h1>
          <p className="iw-sub">只显示分配给我的面试与轮次工作。候选人是招聘业务对象，不是系统用户。</p>
        </div>
      </header>

      <div className="iw-gridwork">
        <div className="iw-min">
          <section className="iw-paper iw-hero">
            <div className="iw-cap">当前分配</div>
            <h2>{stats.assigned_total} 项面试工作</h2>
            <p>Agent 已按本轮招聘标准准备面试简报与建议问题。你负责面试和自己的独立评价。</p>
            <div className="iw-metrics">
              <div className="iw-metric">
                <strong>{stats.open_interview_total}</strong>
                <small>待完成面试</small>
              </div>
              <div className="iw-metric">
                <strong>{stats.pending_scorecard_total}</strong>
                <small>待提交面评</small>
              </div>
              <div className="iw-metric">
                <strong>{stats.submitted_scorecard_total}</strong>
                <small>已提交面评</small>
              </div>
            </div>
          </section>

          <div className="iw-sectionhead">
            <h2>分配给我的工作</h2>
            <small>按 Interview 分配，不按候选人账号</small>
          </div>
          <section className="iw-paper iw-list">
            {overview.interviews.length === 0 ? (
              <p className="iw-empty" data-testid="interviewer-empty">
                分配给你的面试：0 条（服务端按 Interview 分配过滤）
              </p>
            ) : (
              <ul>
                {overview.interviews.map((row) => (
                  <InterviewListItem key={row.interview_id !== '' ? row.interview_id : `row-${row.round_no}-${row.candidate.display_name}`} row={row} onSelect={onSelect} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="iw-aside">
          <section className="iw-paper iw-asidecard">
            <h2>分配轮次与考察重点</h2>
            {rounds.length === 0 ? (
              <p className="iw-muted iw-tiny">打开分配给你的面试后查看对应轮次的考察标准。</p>
            ) : (
              <div>
                {rounds.map((group) => (
                  <div className="iw-roundgroup" key={`round-${group.round_no}`}>
                    <strong>
                      第 {group.round_no} 轮
                      {group.objective !== '' ? ` · ${group.objective}` : ''}
                    </strong>
                    {group.focus.length === 0 ? (
                      <p className="iw-muted iw-tiny">服务端未提供考察重点。</p>
                    ) : (
                      <div className="iw-criteria">
                        {group.focus.map((item) => (
                          <div className="iw-criteriarow" key={`${group.round_no}-${item.key}-${item.label}`}>
                            <span className="iw-dot iw-dot-blue" aria-hidden />
                            <span>{item.label}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="iw-paper iw-asidecard">
            <h2>独立评价</h2>
            <p className="iw-muted iw-tiny">
              默认不展示其他面试官的主观评分和私人备注。后续轮次只接收授权的客观摘要。
            </p>
          </section>
        </aside>
      </div>
    </>
  )
}

/** 详情页（V-I2），含两个独立分支卡片。 */
function DetailView({
  overview,
  row,
  labels,
  endpointUnavailable,
  onBack,
  onOpenScorecard,
}: {
  readonly overview: InterviewerOverview
  readonly row: InterviewRow
  readonly labels: WorkspaceLabels
  readonly endpointUnavailable: boolean
  readonly onBack: () => void
  readonly onOpenScorecard: (row: InterviewRow) => void
}): JSX.Element {
  const candidateName = row.candidate.display_name !== '' ? row.candidate.display_name : '（候选人未提供）'
  const jobText = row.job.title !== '' ? row.job.title : row.job.code !== '' ? row.job.code : '岗位未提供'
  const roundText = row.round_no > 0 ? `第 ${row.round_no} 轮` : '轮次未提供'
  const objectiveText = row.brief.objective !== '' ? row.brief.objective : ''
  const actorText = overview.actor.display_name !== '' ? overview.actor.display_name : '（身份显示名未提供）'
  const briefText = row.brief.briefing !== '' ? row.brief.briefing : row.brief.objective
  const canSubmit = canSubmitScorecard(row)
  const materialFields: readonly MaterialFieldEntry[] =
    row.materials.resume !== null ? materialFieldEntries(row.materials.resume.fields) : []
  const scheduleText = formatSlotRange(row.scheduled_start_at, row.scheduled_end_at, row.timezone)
  const subtitle = [jobText, roundText, objectiveText !== '' ? objectiveText : '本轮目标未提供', `当前身份：${actorText}`]
    .filter((part) => part !== '')
    .join(' · ')

  return (
    <>
      <button type="button" className="iw-back" onClick={onBack} data-testid="back-to-my-interviews">
        ← 返回我的面试
      </button>

      <header className="iw-headline">
        <div className="iw-headline-main">
          <div className="iw-cap">INTERVIEW WORKSPACE</div>
          <h1>{candidateName}</h1>
          <p className="iw-sub">{subtitle}</p>
        </div>
        <span className={`iw-chip ${rowStatusClass(row)}`}>{rowStatusText(row)}</span>
      </header>

      <div className="iw-detailgrid" data-testid="interviewer-detail" data-interview-id={row.interview_id}>
        <div className="iw-min">
          <section className="iw-paper iw-detailmain">
            <div className="iw-insight">
              <h3>本轮面试简报</h3>
              {briefText !== '' ? (
                <p>{briefText}</p>
              ) : (
                <p>服务端未提供本轮简报{row.brief.reason !== '' ? `（${row.brief.reason}）` : ''}。</p>
              )}
              <p className="iw-tiny iw-muted">
                来源：{briefSourceText(row.brief.source)}
                {row.brief.template_version_id !== '' ? ` · template_version：${row.brief.template_version_id}` : ''}
                {row.brief.reason !== '' ? ` · reason：${row.brief.reason}` : ''}
              </p>
            </div>

            <div className="iw-subhead">
              <h2>本轮考察重点</h2>
              <small>只读 · 来自服务端 brief.focus</small>
            </div>
            {row.brief.focus.length === 0 ? (
              <p className="iw-muted iw-tiny">服务端未提供本轮考察重点（不展示占位维度）。</p>
            ) : (
              <div className="iw-criteria">
                {row.brief.focus.map((item, index) => (
                  <div className="iw-criteriarow" key={item.key !== '' ? item.key : `${item.label}-${index}`}>
                    <span className="iw-dot iw-dot-blue" aria-hidden />
                    <span>
                      <strong>
                        {index + 1}. {item.label}
                      </strong>
                    </span>
                    {item.weight !== 0 ? <span className="iw-criteriaweight">权重 {item.weight}</span> : null}
                  </div>
                ))}
              </div>
            )}

            <details className="iw-paper iw-collapse">
              <summary>建议问题（{row.brief.questions.length}）</summary>
              <div>
                {row.brief.questions.length === 0 ? (
                  <p className="iw-muted iw-tiny">服务端未提供建议问题。</p>
                ) : (
                  <div className="iw-sourcebox">{row.brief.questions.map((question) => `• ${question}`).join('\n')}</div>
                )}
              </div>
            </details>

            <details className="iw-paper iw-collapse">
              <summary>查看招聘方接收的简历材料</summary>
              <div>
                {row.materials.available && row.materials.resume !== null ? (
                  <>
                    <p className="iw-tiny iw-muted">
                      授权依据：{row.materials.authorization !== '' ? row.materials.authorization : '（服务端未提供）'} ·
                      parse_status：{row.materials.resume.parse_status !== '' ? row.materials.resume.parse_status : '（未提供）'} ·
                      parser：{row.materials.resume.parser_name !== '' ? row.materials.resume.parser_name : '（未提供）'}
                      {row.materials.resume.parser_version !== '' ? ` @ ${row.materials.resume.parser_version}` : ''}
                    </p>
                    {materialFields.length === 0 ? (
                      <p className="iw-muted iw-tiny">服务端未提供可展示的结构化字段（不展示占位文本）。</p>
                    ) : (
                      <dl className="iw-materials">
                        {materialFields.map((field) => (
                          <div className="iw-materialrow" key={field.key}>
                            <dt>{field.label}</dt>
                            <dd>{field.value}</dd>
                          </div>
                        ))}
                       </dl>
                     )}
                   </>
                 ) : (
                   <p className="iw-muted iw-tiny">{materialsUnavailableText(row)}</p>
                 )}
               </div>
             </details>

            {/* 分支一：材料（Transcript）——只看转写事实，不推断阶段。 */}
            <section
              className="iw-paper iw-branch"
              data-testid="transcript-branch"
              data-transcript-state={row.transcript.state}
              data-reason-code={row.transcript.reason_code}
            >
              <strong className="iw-branchtitle">材料分支 · Transcript</strong>
              <p className="iw-branchstate">
                转写状态：{transcriptStateText(row.transcript.state)}（
                {row.transcript.state !== '' ? row.transcript.state : '服务端未提供'}）
              </p>
              <p className="iw-tiny">
                reason_code：{row.transcript.reason_code !== '' ? row.transcript.reason_code : '（服务端未提供）'} · 会议绑定：
                {meetingBindingStateText(row.transcript.meeting_binding_state)} · 会议数：{row.transcript.meetings_total}
              </p>
              {row.transcript.state !== 'READY' ? (
                <p className="iw-note">
                  转写缺失不影响你提交面评；服务端会以 NO_TRANSCRIPT 记录并进入人工决策（D-111 / 服务端契约负责）。
                </p>
              ) : null}
              <p className="iw-tiny iw-muted">
                本卡片只展示转写事实；前端不判断 S8→S9 / S9→S10 能否推进（G3-B 由服务端阶段闸门负责）。
              </p>
            </section>

            {/* 分支二：面评（我的独立评价）——与转写分支视觉/文案都独立。 */}
            <section
              className="iw-paper iw-branch"
              data-testid="scorecard-branch"
              data-scorecard-state={row.scorecard.state}
              data-scorecard-id={row.scorecard.scorecard_id}
            >
              <strong className="iw-branchtitle">面评分支 · 我的独立评价</strong>
              <p className="iw-branchstate">
                面评状态：{scorecardStateText(row.scorecard.state)}（
                {row.scorecard.state !== '' ? row.scorecard.state : '服务端未提供'}）
              </p>
              {row.scorecard.scorecard_id !== '' ? (
                <p className="iw-tiny">
                  scorecard_id：<span className="iw-mono">{row.scorecard.scorecard_id}</span>
                </p>
              ) : null}
              {row.scorecard.status !== '' ? (
                <p className="iw-tiny">
                  status：{row.scorecard.status} · revision_no：{row.scorecard.revision_no} · record_version：
                  {row.scorecard.record_version}
                </p>
              ) : null}
              {row.scorecard.submitted_at !== '' ? (
                <p className="iw-tiny">submitted_at：{formatSlotTime(row.scorecard.submitted_at, row.timezone)}</p>
              ) : null}
              {row.scorecard.transcript_basis !== '' ? (
                <p className="iw-tiny">transcript_basis：{row.scorecard.transcript_basis}</p>
              ) : null}
              {row.scorecard.overall !== '' ? <p className="iw-tiny">overall：{row.scorecard.overall}</p> : null}
              <p className="iw-tiny iw-muted">只显示你本人的面评；其他面试官的主观评分与私人备注默认不展示。</p>
            </section>

            <div className="iw-divider" />
            <div className="iw-inlineactions">
              <button
                type="button"
                data-testid="open-scorecard"
                className="iw-btn iw-btn-blue"
                disabled={!canSubmit || endpointUnavailable}
                onClick={() => onOpenScorecard(row)}
              >
                提交我的独立面评
              </button>
              {endpointUnavailable ? (
                <span className="iw-tiny iw-muted" data-testid="scorecard-unavailable-note">
                  服务端面评提交入口未就绪（W1）
                </span>
              ) : null}
              {!canSubmit && !endpointUnavailable ? (
                <span className="iw-tiny iw-muted">{openScorecardDisabledReason(row)}</span>
              ) : null}
            </div>
          </section>
        </div>

        <aside className="iw-detailaside">
          <section className="iw-paper iw-actionbox">
            <strong>面试安排</strong>
            <p>{scheduleText !== '' ? scheduleText : '时间未提供'}</p>
            <p className="iw-tiny iw-muted">
              时区：{row.timezone !== '' ? row.timezone : '（服务端未提供）'} · 面试状态：
              {row.status !== '' ? row.status : '（未提供）'} · slot：{row.slot_code !== '' ? row.slot_code : '（未提供）'}
            </p>
            <p className="iw-tiny">会议绑定：{meetingBindingStateText(row.transcript.meeting_binding_state)}</p>
            <p className="iw-tiny">转写状态：{transcriptStateText(row.transcript.state)}</p>
            <p className="iw-tiny">
              面试 id：<span className="iw-mono">{row.interview_id !== '' ? row.interview_id : '（未提供）'}</span>
            </p>
            <div className="iw-labels">
              <span className="iw-chip iw-chip-blue">provenance：{labels.provenance !== '' ? labels.provenance : '未提供'}</span>
              <span className="iw-chip">trigger：{labels.trigger !== '' ? labels.trigger : '未提供'}</span>
              <span className="iw-chip iw-chip-green">connection：{labels.connection !== '' ? labels.connection : '未提供'}</span>
            </div>
            <p className="iw-tiny iw-muted">服务端评估时间（as_of）：{overview.evaluated_at !== '' ? overview.evaluated_at : '（未提供）'}</p>
          </section>
          <section className="iw-paper iw-actionbox">
            <strong>信息可见范围</strong>
            <p>可查看分配给你的面试、本轮 Rubric、授权材料；其他面试官的主观评分与私人备注默认不展示。</p>
            <p className="iw-tiny iw-muted">Provenance / trigger / connection 由服务端按租户现算，前端不重贴标签。</p>
          </section>
        </aside>
      </div>
    </>
  )
}

/** 未绑定身份的 fail-closed 提示（不显示任何面试）。 */
function UnboundBlock({
  missingSession,
  missingAlias,
  parts,
}: {
  readonly missingSession: boolean
  readonly missingAlias: boolean
  readonly parts: ErrorParts | undefined
}): JSX.Element {
  return (
    <section
      className="iw-notice iw-notice-warn"
      data-testid="actor-unmapped"
      data-code={parts !== undefined && parts.code !== '' ? parts.code : 'DEMO_ACTOR_UNMAPPED'}
      data-reason-code={parts !== undefined ? parts.reasonCode : ''}
    >
      <div className="iw-cap">INTERVIEW WORKSPACE</div>
      <strong>当前 Session 尚未绑定演示身份（fail-closed）：请先在顶部选择身份</strong>
      <p>
        {missingSession
          ? '未取得 DSH Session（localStorage 无 dsh.sessions.current），本视图不会用默认身份读数据。'
          : missingAlias
            ? '尚未选择 Demo 身份（alias 为空），本视图不会用默认身份读数据。'
            : '服务端返回 409 DEMO_ACTOR_UNMAPPED；本视图不显示任何面试。'}
      </p>
      {parts !== undefined && parts.message !== '' ? <p>服务端说明：{parts.message}</p> : null}
    </section>
  )
}

/** 读取失败提示（不是"0 条"）。 */
function OverviewErrorBlock({
  parts,
  onRetry,
}: {
  readonly parts: ErrorParts
  readonly onRetry: () => void
}): JSX.Element {
  return (
    <section
      className="iw-notice iw-notice-error"
      role="alert"
      data-testid="overview-error"
      data-code={parts.code}
      data-reason-code={parts.reasonCode}
    >
      <strong>读取「我的面试」失败（不是“0 条”）：{parts.message}</strong>
      <p>
        HTTP {parts.status} · code：{parts.code !== '' ? parts.code : '（无）'} · reason_code：
        {parts.reasonCode !== '' ? parts.reasonCode : '（无）'}
      </p>
      <p>故障不会被显示成空分配；请重试，或先在顶部选择 Demo 身份。</p>
      <button type="button" className="iw-btn iw-btn-sm" onClick={onRetry} data-testid="overview-retry">
        重试
      </button>
    </section>
  )
}

/** 数据库未配置提示（服务端 configured=false；不给假数据）。 */
function NotConfiguredBlock({ overview }: { readonly overview: InterviewerOverview }): JSX.Element {
  return (
    <section className="iw-notice" data-testid="overview-not-configured">
      <strong>数据库未配置，暂时读不到面试工作</strong>
      {overview.issues.length > 0 ? <p>缺少：{overview.issues.join('；')}</p> : null}
      <p>这是配置故障，不是“0 条分配”。</p>
    </section>
  )
}

/**
 * 面试官工作台（main 面板内容）。
 * @param props - sessionId / alias（只来自 W0 shell）。
 * @returns 工作台 JSX（列表或详情，单页内切换）。
 */
export function InterviewerWorkspace(props: WorkspaceProps): JSX.Element {
  // null 不是"默认身份"，是"尚未绑定"：只用于渲染 fail-closed 提示，绝不发 overview 请求。
  const sessionId = (props.sessionId ?? '').trim()
  const alias = (props.alias ?? '').trim()
  const missingSession = props.sessionId === null || sessionId === ''
  const missingAlias = props.alias === null || alias === ''
  const missingBinding = missingSession || missingAlias

  const [overview, setOverview] = useState<InterviewerOverview | undefined>(undefined)
  const [loadFailure, setLoadFailure] = useState<unknown>(undefined)
  const [loading, setLoading] = useState(!missingBinding)
  /** true = 正在等待 shell 的 PUT /actor 落定（loading 文案切换成"正在绑定演示身份…"）。 */
  const [bindingPending, setBindingPending] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [selectedId, setSelectedId] = useState('')
  const [formTarget, setFormTarget] = useState<InterviewRow | null>(null)
  const [endpointUnavailable, setEndpointUnavailable] = useState(false)

  /** 重新 GET 服务端（提交成功后 / 手动重试都走这里，绝不本地改计数）。 */
  const reload = useCallback(() => {
    setGeneration((value) => value + 1)
  }, [])

  // 身份变化：清掉详情与打开中的表单（旧绑定的事实不能继续展示）。
  useEffect(() => {
    setSelectedId('')
    setFormTarget(null)
    setEndpointUnavailable(false)
  }, [sessionId, alias])

  // 挂载 / sessionId / alias / generation 变化都重新 GET（刷新恢复也走这条）。
  //
  // 身份绑定竞态（W0 shell：先改 props，再 await PUT /actor）：props 变了但服务端 registry
  // 还是旧绑定 → 403 SESSION_ALIAS_MISMATCH / 409 DEMO_ACTOR_UNMAPPED。这不是业务错误，
  // 而是"绑定马上落定"，所以做**有界退避重试**（7 次 × 400–500ms，总计约 3.2s）；
  // 只有重试耗尽才把失败渲染成 overview-error / actor-unmapped。重试期间保持 loading，
  // 不伪造数据、不把 409 当"0 条面试"。
  useEffect(() => {
    if (missingBinding) {
      setOverview(undefined)
      setLoadFailure(undefined)
      setBindingPending(false)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true)
    setBindingPending(false)

    /** 可被 Abort 打断的等待（卸载/身份变化立即返回，不留下悬挂的定时器）。 */
    const delay = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined
          resolve()
        }, ms)
        controller.signal.addEventListener(
          'abort',
          () => {
            if (timer !== undefined) {
              clearTimeout(timer)
              timer = undefined
            }
            resolve()
          },
          { once: true },
        )
      })

    const load = async (): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const value = await fetchInterviewerOverview({ sessionId, alias, signal: controller.signal })
          if (!active) return
          setOverview(value)
          setLoadFailure(undefined)
          setBindingPending(false)
          return
        } catch (failure: unknown) {
          if (!active || controller.signal.aborted) return
          const retryable = isBindingPendingError(failure) && attempt < BINDING_RETRY_DELAYS_MS.length
          if (retryable) {
            setBindingPending(true)
            await delay(BINDING_RETRY_DELAYS_MS[attempt] ?? 450)
            if (!active || controller.signal.aborted) return
            continue
          }
          // 失败时清掉旧数据：陈旧列表不能冒充"当前分配"。
          setOverview(undefined)
          setLoadFailure(failure)
          setBindingPending(false)
          return
        }
      }
    }

    void load().finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
      controller.abort()
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }, [sessionId, alias, generation, missingBinding])

  const stats = useMemo(() => (overview !== undefined ? deriveWorkspaceStats(overview) : undefined), [overview])
  const rounds = useMemo(() => (overview !== undefined ? groupRounds(overview.interviews) : []), [overview])
  const errorParts = loadFailure !== undefined ? describeError(loadFailure) : undefined
  const unbound = missingBinding || (errorParts !== undefined && errorParts.code === 'DEMO_ACTOR_UNMAPPED')
  const selectedRow = overview !== undefined && selectedId !== '' ? selectInterview(overview, selectedId) : null

  const openScorecard = (row: InterviewRow): void => {
    setFormTarget(row)
  }
  const closeScorecard = (): void => {
    setFormTarget(null)
  }
  const handleSubmitted = (): void => {
    reload()
  }
  const handleUnavailable = (): void => {
    setEndpointUnavailable(true)
  }

  const showWorkspace =
    !unbound &&
    !loading &&
    errorParts === undefined &&
    overview !== undefined &&
    overview.configured === true
  const showEmptyState =
    showWorkspace && overview !== undefined && selectedId !== '' && selectedRow === null

  return (
    <div
      className="iw-root"
      data-testid="interviewer-workspace"
      data-alias={alias}
      data-session-id={sessionId}
      data-count-assigned={stats !== undefined ? stats.assigned_total : 0}
    >
      <style dangerouslySetInnerHTML={{ __html: INTERVIEWER_CSS }} />
      <div className="iw-view">
        {unbound ? (
          <>
            {/* 未绑定也渲染标题：身份 fail-closed 时页面仍是"我的面试"，只是明确说明读不到任何分配。 */}
            <header className="iw-headline">
              <div className="iw-headline-main">
                <div className="iw-cap">INTERVIEW WORKSPACE</div>
                <h1>我的面试</h1>
                <p className="iw-sub">只显示分配给我的面试与轮次工作。候选人是招聘业务对象，不是系统用户。</p>
              </div>
            </header>
            <UnboundBlock missingSession={missingSession} missingAlias={missingAlias} parts={errorParts} />
          </>
        ) : null}

        {!unbound && overview !== undefined && overview.actor.actor_id !== '' ? (
          <p
            className="iw-actorline"
            data-testid="interviewer-actor-line"
            data-actor-id={overview.actor.actor_id}
            data-alias={overview.actor.alias !== '' ? overview.actor.alias : alias}
          >
            当前身份：<strong>{overview.actor.display_name !== '' ? overview.actor.display_name : '（服务端未提供 display_name）'}</strong>
            （{overview.actor.alias !== '' ? overview.actor.alias : alias}）
          </p>
        ) : null}

        {!unbound && loading ? (
          <p className="iw-loading" data-testid="interviewer-loading" data-binding-pending={bindingPending ? '1' : '0'}>
            {bindingPending ? '正在绑定演示身份…' : '正在读取面试工作…'}
          </p>
        ) : null}

        {!unbound && !loading && errorParts !== undefined ? (
          <OverviewErrorBlock parts={errorParts} onRetry={reload} />
        ) : null}

        {!unbound && !loading && errorParts === undefined && overview !== undefined && !overview.configured ? (
          <NotConfiguredBlock overview={overview} />
        ) : null}

        {showEmptyState ? (
          <p className="iw-notice iw-notice-warn" data-testid="interview-detail-missing">
            该面试已不在你的分配中（服务端读回），本视图不会展示别人的面试。
          </p>
        ) : null}

        {showWorkspace && overview !== undefined && stats !== undefined
          ? selectedRow !== null
            ? (
                <DetailView
                  overview={overview}
                  row={selectedRow}
                  labels={overview.labels}
                  endpointUnavailable={endpointUnavailable}
                  onBack={() => setSelectedId('')}
                  onOpenScorecard={openScorecard}
                />
              )
            : (
                <ListView
                  overview={overview}
                  stats={stats}
                  rounds={rounds}
                  onSelect={(interviewId) => {
                    if (interviewId === '') return
                    setEndpointUnavailable(false)
                    setSelectedId(interviewId)
                  }}
                />
              )
          : null}

        {formTarget !== null ? (
          <ScorecardForm
            key={`${formTarget.interview_id}-${formTarget.application_id}`}
            sessionId={sessionId}
            interviewId={formTarget.interview_id}
            applicationId={formTarget.application_id}
            rubricVersionId={formTarget.rubric !== null ? formTarget.rubric.rubric_version_id : ''}
            onClose={closeScorecard}
            onSubmitted={handleSubmitted}
            onUnavailable={handleUnavailable}
          />
        ) : null}
      </div>
    </div>
  )
}

export default InterviewerWorkspace
