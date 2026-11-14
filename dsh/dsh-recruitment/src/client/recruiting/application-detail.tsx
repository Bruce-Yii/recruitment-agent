// 招聘工作区（W2）申请详情视图：**默认显示业务结论 + 下一步**，其余事实渐进展开。
//
// 渐进展开清单（全部默认收起，用 `<details>`，不加依赖）：
//   简历材料与解析摘要 · 初筛证据（rubric 维度 + SCREENING_EVALUATION + basis kinds）·
//   面试排期与状态 · Transcript 状态 · 已提交面评汇总 · 决策状态 · 时间线。
//
// "同一事项只出现一次"：申请级下一步**只**在顶部结论区出现（`data-testid="next-step"`），
// 各展开区只写事实（材料/证据/排期/转写/面评/决策），不再复述下一步结论。
//
// 错误口径：服务端 404 / 500 / 网络错都在详情卡里显示 `{error:{code,reason_code,message}}` 原文，
// 同时保留头部（来自 overview 行）与禁用态按钮，不白屏、不伪造数据。

import type { ReactNode } from 'react'
import type { RecruitingErrorInfo } from './use-recruiting.ts'
import type {
  ActionView,
  ApplicationDetailView,
  ApplicationHeaderView,
  ApplicationRowView,
  InterviewView,
  MaterialView,
  ResumeView,
} from './view-model.ts'
import {
  ActionButton,
  Card,
  Chip,
  Disclosure,
  EmptyState,
  ErrorAlert,
  KeyValue,
  NextStepPanel,
  SourceBox,
  ThreeDimBadges,
} from './parts.tsx'
import { chipClass } from './styles.ts'

/** 申请详情里可用的写动作（顺序即渲染顺序；可用性仍来自服务端 `actions`）。 */
const APPLICATION_ACTION_KEYS = [
  'screening_decide',
  'interview_schedule',
  'transcript_import',
  'stage_advance',
  'decision_record',
] as const

/** 详情页入参。 */
export interface ApplicationDetailProps {
  /** overview 里对应的行（详情读失败时仍能渲染头部；undefined = 直接深链接打开）。 */
  readonly row: ApplicationRowView | undefined
  /** 申请详情视图模型（未取到时 undefined）。 */
  readonly detail: ApplicationDetailView | undefined
  readonly loading: boolean
  readonly error: RecruitingErrorInfo | undefined
  readonly onRetry: () => void
  readonly onBack: () => void
  /** 重新 GET 申请详情（失败后重试也是它）。 */
  readonly onRefresh: () => void
  readonly refreshing: boolean
  /** 写动作表（详情响应优先，回退 overview）。 */
  readonly actions: Readonly<Record<string, ActionView>>
  readonly pendingActionKey: string
  readonly onRunAction: (action: ActionView) => void
  readonly aliasBlocked: boolean
  readonly aliasNote: string
  /** 同一候选人的其他申请（来自 overview；只显示身份与阶段，不复述结论）。 */
  readonly siblings: ReadonlyArray<ApplicationRowView>
  readonly onOpenApplication: (applicationId: string) => void
  readonly onOpenJob: () => void
}

/** 顶部头部（详情优先，回退 overview 行）。 */
function DetailHeadline({
  header,
  onBack,
  onRefresh,
  refreshing,
}: {
  readonly header: ApplicationHeaderView | undefined
  readonly onBack: () => void
  readonly onRefresh: () => void
  readonly refreshing: boolean
}) {
  const refreshButton = (
    <button
      type="button"
      className="rcw-btn rcw-btn-sm"
      data-testid="refresh-detail"
      disabled={refreshing}
      onClick={onRefresh}
    >
      {refreshing ? '正在读取…' : '刷新'}
    </button>
  )
  if (header === undefined) {
    return (
      <div className="rcw-headline">
        <div className="rcw-headline-left">
          <button type="button" className="rcw-back" data-testid="detail-back" onClick={onBack}>
            ← 返回招聘总览
          </button>
          <span className="rcw-cap">RECRUITING WORKSPACE · APPLICATION</span>
          <h1>申请详情</h1>
        </div>
        <div className="rcw-headline-right">{refreshButton}</div>
      </div>
    )
  }
  return (
    <div className="rcw-headline" data-testid="detail-headline">
      <div className="rcw-headline-left">
        <button type="button" className="rcw-back" data-testid="detail-back" onClick={onBack}>
          ← 返回招聘总览
        </button>
        <span className="rcw-cap">RECRUITING WORKSPACE · APPLICATION</span>
        <h1>
          {header.candidateName}
          <span className="rcw-dim" style={{ fontSize: 15, fontWeight: 590, marginLeft: 8 }}>
            {header.jobTitle}
          </span>
        </h1>
        <div className="rcw-sub">
          <span className="rcw-mono">{header.id !== '' ? header.id : '（服务端未提供申请 id）'}</span>
          <span className="rcw-dim" style={{ marginLeft: 8 }}>
            岗位申请 · 版本 {header.recordVersion}
          </span>
        </div>
      </div>
      <div className="rcw-headline-right">
        <Chip tone={header.stageTone} testid="detail-stage">
          当前阶段 · {header.stageLabel}
        </Chip>
        <Chip tone={header.lifecycleTone} testid="detail-lifecycle">
          申请状态 · {header.lifecycleLabel}
        </Chip>
        {refreshButton}
      </div>
    </div>
  )
}

/** 材料与解析摘要（展开区 1）。 */
function MaterialSection({ material, resume }: { readonly material: MaterialView | null; readonly resume: ResumeView | null }) {
  if (material === null) {
    return <EmptyState>该申请没有关联简历材料（服务端 material 为 null），不展示解析摘要。</EmptyState>
  }
  return (
    <div>
      <div className="rcw-chiprow">
        <Chip tone={material.parseTone} testid="material-parse">
          解析 · {material.parseLabel}
        </Chip>
        <Chip tone={material.validationTone}>校验 · {material.validationLabel}</Chip>
        <Chip tone={material.hashAligned ? 'green' : 'red'} testid="material-hash-aligned">
          来源哈希 · {material.hashAligned ? '一致' : '不一致'}
        </Chip>
      </div>
      <div className="rcw-cardrow" style={{ marginTop: 12 }}>
        <div className="rcw-smallcard">
          <strong>{material.fileName !== '' ? material.fileName : '（服务端未提供文件名）'}</strong>
          <p>
            {material.mimeType !== '' ? material.mimeType : '类型未知'} · {material.byteSizeText !== '' ? material.byteSizeText : '体量未知'}
            {material.pageCountText !== '' ? ` · ${material.pageCountText}` : ''}
          </p>
          <p className="rcw-mono" data-testid="material-sha">
            sha256：{material.sha256Text !== '' ? material.sha256Text : '—'}
          </p>
          {material.sourceSha256Text !== '' ? (
            <p className="rcw-mono">来源 sha256：{material.sourceSha256Text}</p>
          ) : null}
        </div>
        <div className="rcw-smallcard">
          <strong>解析器</strong>
          <p>
            {material.parser !== '' ? material.parser : '（未提供）'}
            {material.parserVersion !== '' ? ` · ${material.parserVersion}` : ''}
          </p>
          <p>
            工作经历 {material.entryCounts.work} 条 · 教育经历 {material.entryCounts.education} 条 · 证据{' '}
            {material.evidenceCount} 条
          </p>
        </div>
      </div>
      {material.fieldStates.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="rcw-cap">字段状态（只给 state，不给邮箱/电话原值）</div>
          <div className="rcw-fields-grid" style={{ marginTop: 8 }}>
            {material.fieldStates.map((field) => (
              <div className="rcw-fieldrow" key={field.key}>
                <span className="rcw-fieldkey">{field.key}</span>
                <span className="rcw-fieldval">{field.state}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="rcw-muted rcw-tiny" style={{ marginTop: 12 }}>
          服务端没有返回字段状态表。
        </p>
      )}
      {resume !== null && resume.fields.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="rcw-cap">结构化字段（可读预览；PII 字段恒为空）</div>
          <div className="rcw-fields-grid" style={{ marginTop: 8 }}>
            {resume.fields.map((field) => (
              <div className="rcw-fieldrow" key={field.key}>
                <span className="rcw-fieldkey">{field.key}</span>
                <span className="rcw-fieldval">
                  {field.state}
                  {field.valuePreview !== '' ? ` · ${field.valuePreview}` : ''}
                  {field.entryCount !== null ? ` · ${String(field.entryCount)} 条` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {resume !== null && resume.workEntries.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="rcw-cap">工作经历</div>
          {resume.workEntries.map((entry, index) => (
            <div className="rcw-criteria" key={`work-${String(index)}`}>
              <span className="rcw-dot rcw-dot-blue" />
              <div className="rcw-criteriabody">
                <strong>
                  {entry.company !== '' ? entry.company : '（未提供公司）'}
                  {entry.title !== '' ? ` · ${entry.title}` : ''}
                </strong>
                <div className="rcw-dim rcw-tiny">
                  {entry.start !== '' ? entry.start : '?'} – {entry.end !== '' ? entry.end : '至今'}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {resume !== null && resume.educationEntries.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="rcw-cap">教育经历</div>
          {resume.educationEntries.map((entry, index) => (
            <div className="rcw-criteria" key={`edu-${String(index)}`}>
              <span className="rcw-dot rcw-dot-blue" />
              <div className="rcw-criteriabody">
                {entry.text !== '' ? entry.text : '（未提供文本）'}
                <div className="rcw-dim rcw-tiny">
                  {entry.start !== '' ? entry.start : '?'} – {entry.end !== '' ? entry.end : '至今'}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {resume !== null && resume.evidenceSamples.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="rcw-cap">简历证据（页码 + 短引文；不含 PII）</div>
          {resume.evidenceSamples.map((sample, index) => (
            <div className="rcw-quote" key={`evidence-${String(index)}`}>
              <div className="rcw-dim rcw-tiny">
                字段 {sample.field !== '' ? sample.field : '—'} · 第 {sample.page !== null ? String(sample.page) : '?'} 页
                {sample.block !== null ? ` · block ${String(sample.block)}` : ''}
              </div>
              {sample.quote}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 初筛证据（展开区 2）：结论 + rubric 维度 + SCREENING_EVALUATION + basis kinds。 */
function ScreeningSection({
  evidence,
}: {
  readonly evidence: ApplicationDetailView['screeningEvidence']
}) {
  const { decision, rubric, basis } = evidence
  return (
    <div>
      {decision === null ? (
        <EmptyState>还没有初筛结论（当前有效的 SCREENING 决定不存在）。</EmptyState>
      ) : (
        <>
          <div className="rcw-chiprow">
            <Chip tone={decision.resultTone} testid="screening-result">
              初筛结论 · {decision.resultLabel}
            </Chip>
            {decision.stageLabel !== '' ? <Chip tone="gray">{decision.stageLabel}</Chip> : null}
            {decision.decidedBy !== '' ? <Chip tone="blue">由 {decision.decidedBy} 决定</Chip> : null}
            <span className="rcw-dim rcw-tiny">{decision.decidedAtText !== '' ? decision.decidedAtText : '时间未提供'}</span>
          </div>
          <SourceBox testid="screening-reason">{decision.reason !== '' ? decision.reason : '（服务端未提供理由）'}</SourceBox>
          <div style={{ marginTop: 10 }}>
            <KeyValue label="决定 id" value={decision.decisionId} mono />
            <KeyValue label="rubric 版本 id" value={decision.rubricVersionId} mono />
            <KeyValue
              label="basis kinds"
              value={decision.basisKinds.length > 0 ? decision.basisKinds.join('、') : ''}
            />
          </div>
          {decision.evaluation !== null ? (
            <div className="rcw-insight" style={{ marginTop: 12 }} data-testid="screening-evaluation">
              <h3>SCREENING_EVALUATION 机器证据</h3>
              <div className="rcw-chiprow" style={{ marginTop: 6 }}>
                <Chip tone={decision.evaluation.verdict !== '' ? 'blue' : 'gray'}>
                  verdict · {decision.evaluation.verdict !== '' ? decision.evaluation.verdict : '未提供'}
                </Chip>
                <Chip tone={decision.evaluation.provenanceTone}>
                  provenance · {decision.evaluation.provenance !== '' ? decision.evaluation.provenance : '未提供'}
                </Chip>
                <Chip tone={decision.evaluation.criteriaEvaluated === true ? 'green' : 'gray'}>
                  criteria_evaluated ·{' '}
                  {decision.evaluation.criteriaEvaluated === null
                    ? '未提供'
                    : decision.evaluation.criteriaEvaluated
                      ? '是'
                      : '否'}
                </Chip>
              </div>
              <div style={{ marginTop: 8 }}>
                <KeyValue label="evaluation digest" value={decision.evaluation.evaluationDigestText} mono />
                <KeyValue label="凭据 resume_version" value={decision.evaluation.resumeVersionId} mono />
                <KeyValue label="凭据 rubric_version" value={decision.evaluation.rubricVersionId} mono />
              </div>
            </div>
          ) : (
            <p className="rcw-muted rcw-tiny" style={{ marginTop: 10 }}>
              该初筛结论没有携带 SCREENING_EVALUATION 分片（basis_refs 里没有机器证据）。
            </p>
          )}
        </>
      )}

      <div className="rcw-subhead">
        <h3>Rubric 维度快照</h3>
        {rubric !== null ? (
          <span className="rcw-dim rcw-tiny">
            rubric r{String(rubric.versionNo)} · {rubric.dimensions.length} 个维度
          </span>
        ) : null}
      </div>
      {rubric === null || rubric.dimensions.length === 0 ? (
        <EmptyState>没有可用的 rubric 维度快照。</EmptyState>
      ) : (
        rubric.dimensions.map((dimension) => (
          <div className="rcw-criteria" key={dimension.key} data-dim-key={dimension.key}>
            <span className="rcw-dot rcw-dot-blue" />
            <div className="rcw-criteriabody">
              <strong>
                {dimension.label}（{dimension.key}）
              </strong>
              <span className="rcw-dim rcw-tiny" style={{ marginLeft: 6 }}>
                {dimension.kind}
                {dimension.weight !== null ? ` · 权重 ${String(dimension.weight)}` : ''}
                {dimension.operator !== '' ? ` · ${dimension.operator}` : ''}
                {dimension.valuePreview !== '' ? ` · 阈值 ${dimension.valuePreview}` : ''}
              </span>
              {dimension.question !== '' ? <div className="rcw-dim rcw-tiny">问题：{dimension.question}</div> : null}
            </div>
          </div>
        ))
      )}

      {basis.length > 0 ? (
        <>
          <div className="rcw-subhead">
            <h3>basis 分片（安全投影）</h3>
          </div>
          {basis.map((entry, index) => (
            <div className="rcw-quote rcw-mono" key={`basis-${String(index)}-${entry.kind}`}>
              {entry.kind}
              {entry.detailText !== '' ? ` · ${entry.detailText}` : ''}
            </div>
          ))}
        </>
      ) : null}
    </div>
  )
}

/** 面试排期与状态（展开区 3）。 */
function InterviewSection({ interviews }: { readonly interviews: ReadonlyArray<InterviewView> }) {
  if (interviews.length === 0) return <EmptyState>该申请还没有面试记录（没有排期就是没有排期，不推断）。</EmptyState>
  return (
    <>
      {interviews.map((interview) => (
        <div className="rcw-smallcard" style={{ marginTop: 10 }} key={interview.id} data-testid={`interview-${interview.id}`}>
          <div className="rcw-chiprow">
            <strong>
              第 {interview.roundNo} 轮 · {interview.slotCode !== '' ? interview.slotCode : '（未提供 slot）'}
            </strong>
            <Chip tone={interview.statusTone}>排期状态 · {interview.statusLabel}</Chip>
            {interview.stageLabel !== '' ? <Chip tone="gray">{interview.stageLabel}</Chip> : null}
            <Chip tone={interview.scorecards.tone} testid={`interview-${interview.id}-scorecard`}>
              面评 · {interview.scorecards.summaryText}
            </Chip>
          </div>
          <div style={{ marginTop: 8 }}>
            <KeyValue
              label="开始"
              value={interview.scheduledStartText !== '' ? interview.scheduledStartText : ''}
            />
            <KeyValue label="结束" value={interview.scheduledEndText !== '' ? interview.scheduledEndText : ''} />
            <KeyValue label="时区" value={interview.timezone} />
            <KeyValue
              label="面评进度"
              value={
                interview.scorecards.required === 0
                  ? '该轮不需要面评'
                  : `已提交 ${String(interview.scorecards.submitted)} / 必需 ${String(interview.scorecards.required)} · 缺失 ${String(interview.scorecards.missing)} · 逾期 ${String(interview.scorecards.overdue)}`
              }
            />
          </div>
          {interview.interviewers.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div className="rcw-cap">面试官与本人面评</div>
              {interview.interviewers.map((interviewer) => (
                <div className="rcw-fieldrow" key={interviewer.id !== '' ? interviewer.id : interviewer.actorId}>
                  <span className="rcw-fieldkey">
                    {interviewer.displayName}
                    {interviewer.roleInInterview !== '' ? ` · ${interviewer.roleInInterview}` : ''}
                    {interviewer.required ? ' · 必需面评' : ''}
                  </span>
                  <span className="rcw-fieldval">
                    {interviewer.scorecard !== null ? (
                      <>
                        <span className={chipClass(interviewer.scorecard.statusTone)}>{interviewer.scorecard.statusLabel}</span>
                        {interviewer.scorecard.overallLabel !== '' ? ` · ${interviewer.scorecard.overallLabel}` : ''}
                        {interviewer.scorecard.submittedAtText !== '' ? ` · ${interviewer.scorecard.submittedAtText}` : ''}
                      </>
                    ) : (
                      <span className="rcw-dim">未提交{interviewer.dueAtText !== '' ? ` · 截止 ${interviewer.dueAtText}` : ''}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </>
  )
}

/** Transcript 状态（展开区 4）：只给状态/计数，不给正文。 */
function TranscriptSection({
  interviews,
  runs,
}: {
  readonly interviews: ReadonlyArray<InterviewView>
  readonly runs: ApplicationDetailView['transcriptRuns']
}) {
  const rows = interviews.filter((interview) => interview.transcript.state !== '' || interview.transcript.artifactId !== '')
  return (
    <div>
      {rows.length === 0 ? (
        <EmptyState>没有找到与面试关联的 Transcript 事实（不代表未录取，只代表没有可读状态）。</EmptyState>
      ) : (
        rows.map((interview) => {
          const transcript = interview.transcript
          return (
            <div className="rcw-smallcard" style={{ marginTop: 10 }} key={interview.id} data-testid={`transcript-${interview.id}`}>
              <div className="rcw-chiprow">
                <strong>
                  第 {interview.roundNo} 轮 · {interview.slotCode !== '' ? interview.slotCode : '（未提供 slot）'}
                </strong>
                <Chip tone={transcript.stateTone} testid={`transcript-${interview.id}-state`}>
                  Transcript · {transcript.stateLabel}
                </Chip>
                {transcript.transcriptStatus !== '' ? (
                  <Chip tone={transcript.transcriptStatusTone}>{transcript.transcriptStatusLabel}</Chip>
                ) : null}
                <Chip tone={transcript.isCanonical ? 'green' : 'gray'}>
                  canonical · {transcript.isCanonical ? '是' : '否'}
                </Chip>
                <Chip tone={transcript.isComplete ? 'green' : 'gray'}>
                  complete · {transcript.isComplete ? '是' : '否'}
                </Chip>
              </div>
              <div style={{ marginTop: 8 }}>
                <KeyValue label="artifact id" value={transcript.artifactId} mono />
                <KeyValue label="分段数" value={String(transcript.segmentCount)} />
              </div>
              <div style={{ marginTop: 6 }}>
                <ThreeDimBadges labels={transcript.labels} testid={`transcript-${interview.id}-labels`} />
              </div>
              {transcript.record !== null ? (
                <div style={{ marginTop: 8 }}>
                  <div className="rcw-cap">面试记录（独立分支）</div>
                  <KeyValue label="状态" value={transcript.record.status} />
                  <KeyValue label="校验" value={transcript.record.verificationStatus} />
                  <KeyValue label="证据齐备" value={transcript.record.evidenceOk ? '是' : '否'} />
                  <KeyValue label="当前有效" value={transcript.record.isCurrent ? '是' : '否'} />
                  <KeyValue
                    label="chunk coverage"
                    value={transcript.record.chunkCoverageText !== '' ? transcript.record.chunkCoverageText : ''}
                  />
                </div>
              ) : null}
            </div>
          )
        })
      )}
      {runs.length > 0 ? (
        <>
          <div className="rcw-subhead">
            <h3>转写处理运行</h3>
          </div>
          <div className="rcw-tablewrap">
            <table className="rcw-table">
              <thead>
                <tr>
                  <th>run</th>
                  <th>artifact</th>
                  <th>状态</th>
                  <th>分片（成功/总数）</th>
                  <th>失败</th>
                  <th>model</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId !== '' ? run.runId : `${run.artifactId}-run`}>
                    <td className="rcw-mono">{run.runId !== '' ? run.runId : '—'}</td>
                    <td className="rcw-mono">{run.artifactIdText !== '' ? run.artifactIdText : '—'}</td>
                    <td>{run.status !== '' ? run.status : '—'}</td>
                    <td>
                      {String(run.chunkSucceeded)}/{String(run.chunkTotal)}
                    </td>
                    <td>{run.chunkFailed}</td>
                    <td>{run.modelId !== '' ? run.modelId : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** 已提交面评汇总（展开区 5）。 */
function ScorecardSection({ interviews }: { readonly interviews: ReadonlyArray<InterviewView> }) {
  const rows: { readonly interview: InterviewView; readonly interviewerName: string; readonly scorecard: NonNullable<InterviewView['interviewers'][number]['scorecard']> }[] = []
  for (const interview of interviews) {
    for (const interviewer of interview.interviewers) {
      if (interviewer.scorecard === null) continue
      rows.push({
        interview,
        interviewerName: interviewer.displayName !== '' ? interviewer.displayName : '（未提供姓名）',
        scorecard: interviewer.scorecard,
      })
    }
  }
  if (rows.length === 0) return <EmptyState>还没有已提交的面评（服务端没有返回任何 scorecard）。</EmptyState>
  return (
    <div className="rcw-tablewrap">
      <table className="rcw-table">
        <thead>
          <tr>
            <th>轮次</th>
            <th>面试官</th>
            <th>状态</th>
            <th>overall</th>
            <th>revision</th>
            <th>提交时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.scorecard.id} data-testid={`scorecard-${row.scorecard.id}`}>
              <td>第 {row.interview.roundNo} 轮</td>
              <td>{row.interviewerName}</td>
              <td>
                <span className={chipClass(row.scorecard.statusTone)}>{row.scorecard.statusLabel}</span>
              </td>
              <td>{row.scorecard.overallLabel !== '' ? row.scorecard.overallLabel : '—'}</td>
              <td>{row.scorecard.revisionNo}</td>
              <td>{row.scorecard.submittedAtText !== '' ? row.scorecard.submittedAtText : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 决策状态（展开区 6）：当前有效 + 历史。 */
function DecisionSection({ decisions }: { readonly decisions: ReadonlyArray<ApplicationDetailView['decisions'][number]> }) {
  if (decisions.length === 0) return <EmptyState>还没有招聘决策记录（decision 表对该申请为空）。</EmptyState>
  return (
    <>
      {decisions.map((decision) => (
        <div className="rcw-smallcard" style={{ marginTop: 10 }} key={decision.id} data-testid={`decision-${decision.id}`}>
          <div className="rcw-chiprow">
            <Chip tone={decision.resultTone}>{decision.scopeLabel !== '' ? decision.scopeLabel : '决策'} · {decision.resultLabel}</Chip>
            <Chip tone={decision.isCurrent ? 'green' : 'gray'}>{decision.isCurrent ? '当前有效' : '已被取代'}</Chip>
            {decision.stageLabel !== '' ? <Chip tone="gray">{decision.stageLabel}</Chip> : null}
            <span className="rcw-dim rcw-tiny">
              {decision.decidedBy !== '' ? `由 ${decision.decidedBy} 决定` : '决定人未提供'}
              {decision.decidedAtText !== '' ? ` · ${decision.decidedAtText}` : ''}
            </span>
          </div>
          <SourceBox>{decision.reason !== '' ? decision.reason : '（服务端未提供理由）'}</SourceBox>
          <div style={{ marginTop: 6 }}>
            <KeyValue label="decision id" value={decision.id} mono />
            <KeyValue label="scope" value={decision.scope} />
            <KeyValue label="basis kinds" value={decision.basisKinds.join('、')} />
            {decision.supersededBy !== '' ? <KeyValue label="superseded_by" value={decision.supersededBy} mono /> : null}
          </div>
        </div>
      ))}
    </>
  )
}

/** 时间线（展开区 7）。 */
function TimelineSection({ timeline }: { readonly timeline: ApplicationDetailView['timeline'] }) {
  if (timeline.length === 0) return <EmptyState>没有可展示的时间线事实。</EmptyState>
  return (
    <div className="rcw-timeline">
      {timeline.map((entry, index) => (
        <div className="rcw-timelineitem" key={`${entry.at}-${entry.kind}-${String(index)}`}>
          {entry.label !== '' ? entry.label : entry.kindLabel !== '' ? entry.kindLabel : entry.kind}
          <small>
            {entry.atText !== '' ? entry.atText : '时间未提供'}
            {entry.kindLabel !== '' ? ` · ${entry.kindLabel}` : ''}
            {entry.refId !== '' ? ` · ${entry.refId}` : ''}
          </small>
        </div>
      ))}
    </div>
  )
}

/** 一个"展开区"壳（加载中/不可用时给出明确说明，不伪造内容）。 */
function LazySection({
  title,
  testid,
  available,
  children,
}: {
  readonly title: string
  readonly testid: string
  readonly available: boolean
  readonly children: ReactNode
}) {
  return (
    <Disclosure title={title} testid={testid}>
      {available ? children : <EmptyState>详情数据尚未读取成功（或服务端未返回该段），展开内容不可用。</EmptyState>}
    </Disclosure>
  )
}

/**
 * 申请详情视图。
 * @param props - 见 {@link ApplicationDetailProps}。
 * @returns 详情页 JSX（结论 + 渐进展开 + aside）。
 */
export function ApplicationDetail(props: ApplicationDetailProps) {
  const header = props.detail?.header ?? props.row
  const step = props.detail?.nextStep ?? props.row?.nextStep
  const detail = props.detail
  const material = detail?.material ?? props.row?.material ?? null
  const interviews = detail?.interviews ?? props.row?.interviews ?? []
  const scorecardProgress = detail?.scorecardProgress ?? props.row?.scorecardProgress
  const transcriptSummary =
    detail !== undefined ? detail.transcriptSummary : (props.row?.transcriptSummary ?? '')
  const transcriptTone = detail !== undefined ? detail.transcriptTone : (props.row?.transcriptTone ?? 'gray')
  const materialSummary = props.row !== undefined ? props.row.materialSummary : (material !== null ? material.parseLabel : '未关联材料')
  const actionList = APPLICATION_ACTION_KEYS.map((key) => props.actions[key]).filter(
    (action): action is ActionView => action !== undefined,
  )

  return (
    <>
      <DetailHeadline header={header} onBack={props.onBack} onRefresh={props.onRefresh} refreshing={props.refreshing} />

      {props.error !== undefined ? (
        <ErrorAlert
          title="申请详情读取失败"
          message={props.error.message}
          rawBody={props.error.rawBody}
          onRetry={props.onRetry}
        />
      ) : null}

      <div className="rcw-grid rcw-detailgrid">
        <div className="rcw-main">
          <Card className="rcw-detailmain" testid="detail-conclusion">
            {step !== undefined ? (
              <NextStepPanel step={step} scope="application" />
            ) : (
              <div className="rcw-nextstep" data-testid="next-step" data-scope="application" data-code="" data-has-step="false">
                <span className="rcw-cap">业务结论 · 下一步</span>
                <div className="rcw-nextstep-main">
                  <strong>正在读取申请详情…</strong>
                </div>
              </div>
            )}

            <div className="rcw-inlineactions" data-testid="detail-actions">
              {actionList.map((action) => (
                <ActionButton
                  key={action.key}
                  action={action}
                  pending={props.pendingActionKey === action.key}
                  aliasBlocked={props.aliasBlocked}
                  aliasNote={props.aliasNote}
                  onRun={props.onRunAction}
                />
              ))}
            </div>

            <div className="rcw-divider" />

            <div className="rcw-metrics">
              <div className="rcw-metric" data-testid="detail-metric-material">
                <strong style={{ fontSize: 15 }}>{materialSummary !== '' ? materialSummary : '未关联材料'}</strong>
                <small>简历材料与解析</small>
              </div>
              <div className="rcw-metric" data-testid="detail-metric-interviews">
                <strong>{interviews.length}</strong>
                <small>面试轮次</small>
              </div>
              <div className="rcw-metric" data-testid="detail-metric-scorecards">
                <strong style={{ fontSize: 15 }}>
                  {scorecardProgress !== undefined ? scorecardProgress.summaryText : '—'}
                </strong>
                <small>面评进度（服务端聚合）</small>
              </div>
              <div className="rcw-metric" data-testid="detail-metric-transcript">
                <strong style={{ fontSize: 15 }}>
                  <span className={chipClass(transcriptTone)}>{transcriptSummary !== '' ? transcriptSummary : '状态未知'}</span>
                </strong>
                <small>Transcript 状态</small>
              </div>
            </div>

            {props.loading && detail === undefined ? (
              <p className="rcw-loading" data-testid="detail-loading">
                正在读取申请详情…
              </p>
            ) : null}

            <LazySection title="简历材料与解析摘要" testid="section-material" available={detail !== undefined}>
              <MaterialSection material={detail?.material ?? null} resume={detail?.resume ?? null} />
            </LazySection>
            <LazySection
              title="初筛证据 · rubric 维度 / SCREENING_EVALUATION / basis kinds"
              testid="section-screening"
              available={detail !== undefined}
            >
              <ScreeningSection
                evidence={detail?.screeningEvidence ?? { decision: null, rubric: null, basis: [] }}
              />
            </LazySection>
            <LazySection title="面试排期与状态" testid="section-interviews" available={detail !== undefined}>
              <InterviewSection interviews={detail?.interviews ?? []} />
            </LazySection>
            <LazySection title="Transcript 状态" testid="section-transcript" available={detail !== undefined}>
              <TranscriptSection interviews={detail?.interviews ?? []} runs={detail?.transcriptRuns ?? []} />
            </LazySection>
            <LazySection title="已提交面评汇总" testid="section-scorecards" available={detail !== undefined}>
              <ScorecardSection interviews={detail?.interviews ?? []} />
            </LazySection>
            <LazySection title="决策状态（当前有效 + 历史）" testid="section-decisions" available={detail !== undefined}>
              <DecisionSection decisions={detail?.decisions ?? []} />
            </LazySection>
            <LazySection title="时间线" testid="section-timeline" available={detail !== undefined}>
              <TimelineSection timeline={detail?.timeline ?? []} />
            </LazySection>
          </Card>
        </div>

        <aside className="rcw-aside rcw-detailaside">
          <Card className="rcw-asidecard" testid="detail-aside-stage">
            <h2>申请事实</h2>
            {header !== undefined ? (
              <>
                <div className="rcw-chiprow" style={{ marginTop: 8 }}>
                  <Chip tone={header.stageTone}>{header.stageLabel}</Chip>
                  <Chip tone={header.lifecycleTone}>{header.lifecycleLabel}</Chip>
                </div>
                <div style={{ marginTop: 10 }}>
                  <KeyValue label="申请时间" value={header.appliedAtText} />
                  <KeyValue label="进入本阶段" value={header.stageEnteredAtText} />
                  <KeyValue label="记录版本" value={String(header.recordVersion)} />
                  <KeyValue label="岗位" value={header.jobTitle} />
                </div>
                {header.stageBlockedReason !== '' ? (
                  <p className="rcw-alert" style={{ marginTop: 10, marginBottom: 0 }}>
                    阶段阻塞原因：{header.stageBlockedReason}
                  </p>
                ) : null}
              </>
            ) : (
              <EmptyState>没有申请头部数据。</EmptyState>
            )}
          </Card>

          <Card className="rcw-asidecard" testid="detail-aside-siblings">
            <h2>同一候选人的其他申请</h2>
            {props.siblings.length === 0 ? (
              <EmptyState>没有同一候选人的其他岗位申请。</EmptyState>
            ) : (
              <div className="rcw-joblist">
                {props.siblings.map((sibling) => (
                  <button
                    key={sibling.rowKey}
                    type="button"
                    className="rcw-jobrow"
                    data-testid={`sibling-row-${sibling.id}`}
                    onClick={() => props.onOpenApplication(sibling.id)}
                  >
                    <span className="rcw-av">{sibling.candidateInitial}</span>
                    <span className="rcw-rowmain">
                      <strong>{sibling.jobTitle}</strong>
                      <small>{sibling.stageLabel} · {sibling.lifecycleLabel}</small>
                    </span>
                    <Chip tone={sibling.stageTone}>{sibling.stageLabel}</Chip>
                    <span className="rcw-chev">›</span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card className="rcw-asidecard" testid="detail-aside-labels">
            <h2>数据来源与标签</h2>
            {detail !== undefined ? (
              <>
                <ThreeDimBadges labels={detail.labels} testid="detail-labels" />
                <div style={{ marginTop: 8 }}>
                  <KeyValue label="评估时间" value={detail.evaluatedAtText} />
                  <KeyValue label="契约版本" value={detail.contractVersion} />
                  <KeyValue label="读取身份" value={detail.actor.displayName} />
                </div>
              </>
            ) : (
              <EmptyState>详情读取成功后显示三维标签与契约版本。</EmptyState>
            )}
            <button type="button" className="rcw-textbtn" data-testid="open-job-from-detail" onClick={props.onOpenJob}>
              查看该岗位版本与 rubric →
            </button>
          </Card>
        </aside>
      </div>
    </>
  )
}
