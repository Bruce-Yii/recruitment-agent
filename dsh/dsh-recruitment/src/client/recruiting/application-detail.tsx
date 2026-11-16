// 招聘工作区（W2b）申请详情视图：**默认显示业务结论 + 下一步**，其余事实渐进展开。
//
// W2b 改动（INTERFACE.md §2.3 / INTERFACE2.md §4）：
//   · P0/P1 写入口从"一个泛按钮"改成**契约表单**（stage/advance、screening/decide、decision/record facade、
//     interview/schedule CREATE、transcript/import）；body 一律由 `actions.ts` 的 `build*` 产出，
//     契约事实缺失 → disabled + 精确 reasonCode，**不发请求**；
//   · `action-result` 读回区展示 `actionResultLines()`（键/值原样，不做业务推断）；
//   · 面试卡渲染 `RoundFocusCard`（task-50 的 `round_focus` 投影）。
//
// 渐进展开清单（全部默认收起，用 `<details>`，不加依赖）：
//   简历材料与解析摘要 · 初筛证据 · 面试排期与状态（含本轮重点）· Transcript 状态 ·
//   已提交面评汇总 · 决策状态 · 时间线。
//
// "同一事项只出现一次"：申请级下一步**只**在顶部结论区出现（`data-testid="next-step"`），
// 各展开区只写事实，不再复述下一步结论。
//
// 错误口径：服务端 404 / 500 / 网络错都在详情卡里显示 `{error:{code,reason_code,message}}` 原文，
// 同时保留头部（来自 overview 行）与禁用态按钮，不白屏、不伪造数据。
//
// 组件**纯展示**：不 fetch、不读 localStorage；facts 由 workspace 取数后经 `decisionFacts` 传入，
// 写动作一律经 `onRunAction` / `onScreeningEvaluate` / `onDecisionRecord` 回调交给数据层。

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { RecruitingErrorInfo } from './use-recruiting.ts'
import {
  actionResultLines,
  blockerTextOf,
  buildDecisionRecordBody,
  buildInterviewScheduleBody,
  buildScreeningDecisionBody,
  buildStageAdvanceBody,
  buildTranscriptImportBody,
  decisionRecordBlockers,
  describeActionError,
  interviewerCandidates,
  interviewChoices,
  newIdempotencyKey,
  screeningDecisionBlockers,
  toOffsetIso,
  type ActionOutcome,
  type BodyBuildResult,
  type DecisionFacts,
} from './actions.ts'
import type {
  ActionView,
  ApplicationDetailView,
  ApplicationHeaderView,
  ApplicationRowView,
  InterviewView,
  MaterialView,
  ResumeView,
  SettingsView,
} from './view-model.ts'
import { applicationRubricTextOf } from './view-model.ts'
import {
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
import { RoundFocusCard } from './round-focus.tsx'
import { chipClass } from './styles.ts'

/** 申请详情里可用的写动作（顺序即渲染顺序；可用性仍来自服务端 `actions`）。 */
const APPLICATION_ACTION_KEYS = [
  'screening_decide',
  'interview_schedule',
  'transcript_import',
  'stage_advance',
  'decision_record',
] as const

/** 表单控件的内联样式（styles.ts 属 B 的写范围，本组件不写 CSS）。 */
const FIELD_STYLE = {
  background: '#fff',
  border: '1px solid var(--rcw-border2, #d6dde8)',
  borderRadius: 8,
  padding: '7px 9px',
  color: '#33465e',
  fontSize: 12,
  width: '100%',
  boxSizing: 'border-box',
} as const

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
  /** 执行一次写动作：body 必须由 `build*` 产出（组件从不发 `{}`）。 */
  readonly onRunAction: (action: ActionView, request: Readonly<Record<string, unknown>>) => void
  readonly aliasBlocked: boolean
  readonly aliasNote: string
  /** 同一候选人的其他申请（来自 overview；只显示身份与阶段，不复述结论）。 */
  readonly siblings: ReadonlyArray<ApplicationRowView>
  readonly onOpenApplication: (applicationId: string) => void
  readonly onOpenJob: () => void
  /** 最近一次写动作结果（显示服务端 readback；undefined = 尚未执行写动作）。 */
  readonly actionOutcome: ActionOutcome | undefined
  /** 招聘设置（overview.settings；schedule 面试官候选来自 hiringTeams[].members[]）。 */
  readonly settings: SettingsView | undefined
  /** 决策事实只读投影（workspace 用 `useDecisionFacts` 取数后传入；undefined = 未接线/未读取）。 */
  readonly decisionFacts: DecisionFacts | undefined
  /** facts 取数状态（区分"路由 404 未接线"与"读取中/失败"；缺省按未接线处理）。 */
  readonly decisionFactsProbe?: 'READY' | 'MISSING' | 'ERROR' | 'LOADING'
  /** 执行初筛评估（`POST /recruitment/api/decision/screening/evaluate`；由 workspace 注入数据层调用）。 */
  readonly onScreeningEvaluate?: () => void
  /** 记录正式决策（`POST /recruitment/api/decision/record` facade；body 由本组件用 `buildDecisionRecordBody` 产出）。 */
  readonly onDecisionRecord?: (request: Readonly<Record<string, unknown>>) => void
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
        <div className="rcw-sub" data-application-id={header.id !== '' ? header.id : undefined}>
          {/* O6：申请 UUID 是内部 id，不作 HR 主文案；显示业务岗位编号（没有就如实写未提供）。 */}
          <span className="rcw-dim">
            岗位编号 {header.jobCode !== '' ? header.jobCode : '（未提供）'}
          </span>
          <span className="rcw-dim" style={{ marginLeft: 8 }}>
            申请记录版本 {header.recordVersion}
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
        {/* O13：本申请钉住的评分标准（与「岗位当前 Rubric」是两个事实，分开标注）。 */}
        <Chip
          tone={header.applicationRubric === null ? 'gray' : header.applicationRubric.approved ? 'green' : 'amber'}
          testid="detail-application-rubric"
        >
          本申请钉住 Rubric · {applicationRubricTextOf(header.applicationRubric)}
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
            <Chip tone={decision.resultTone} testid="screening-decision-result">
              初筛结论 · {decision.resultLabel}
            </Chip>
            {decision.stageLabel !== '' ? <Chip tone="gray">{decision.stageLabel}</Chip> : null}
            {decision.decidedBy !== '' ? <Chip tone="blue">由 {decision.decidedBy} 决定</Chip> : null}
            <span className="rcw-dim rcw-tiny">{decision.decidedAtText !== '' ? decision.decidedAtText : '时间未提供'}</span>
          </div>
          <SourceBox testid="screening-reason-readback">
            {decision.reason !== '' ? decision.reason : '（服务端未提供理由）'}
          </SourceBox>
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
            初筛结论所用 Rubric 快照 · v{String(rubric.versionNo)} · {rubric.dimensions.length} 个维度
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

/** 面试排期与状态（展开区 3）：每轮附 task-50 的「本轮重点」卡。 */
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
                  : `已提交 ${String(interview.scorecards.submitted)} / 必需 ${String(interview.scorecards.required)} · 未提交 ${String(interview.scorecards.missing)} · 逾期 ${String(interview.scorecards.overdue)}`
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
          <RoundFocusCard focus={interview.roundFocus} />
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

// =====================================================================
//  写动作表单（P0/P1）：body 由 actions.ts 的 build* 产出；事实缺失 → disabled 不发请求
// =====================================================================

/** 表单里的一个字段（label + 控件）。 */
function FormField({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginTop: 8 }}>
      <span className="rcw-cap" style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </span>
      {children}
      {hint !== undefined && hint !== '' ? (
        <span className="rcw-dim rcw-tiny" style={{ display: 'block', marginTop: 3 }}>
          {hint}
        </span>
      ) : null}
    </label>
  )
}

/** 一个写动作卡片的外壳（`data-testid="action-<key>"` 是浏览器证据钩子）。 */
function ActionCard({
  actionKey,
  title,
  available,
  blockedReason,
  children,
}: {
  readonly actionKey: string
  readonly title: string
  readonly available: boolean
  readonly blockedReason: string
  readonly children: ReactNode
}) {
  return (
    <div
      className="rcw-smallcard"
      style={{ marginTop: 14 }}
      data-testid={`action-${actionKey}`}
      data-available={available ? 'true' : 'false'}
      data-blocked-reason={blockedReason}
    >
      <div className="rcw-chiprow">
        <strong>{title}</strong>
        <Chip tone={available ? 'green' : 'gray'}>{available ? '事实齐备，可提交' : '禁用（缺事实/越权）'}</Chip>
      </div>
      {children}
      {blockedReason !== '' ? (
        <p className="rcw-pending" data-testid={`pending-${actionKey}`} style={{ marginTop: 8 }}>
          {blockedReason}
        </p>
      ) : null}
    </div>
  )
}

/** 结构性禁用原因（服务端不可用 / alias 越权 / 提交中）；空串 = 结构上可提交。 */
function structuralReason(
  action: ActionView | undefined,
  binding: { readonly aliasBlocked: boolean; readonly aliasNote: string; readonly pending: boolean },
): string {
  if (action === undefined) return '当前页面版本没有提供这个操作'
  if (!action.available) {
    return action.reasonText !== '' ? action.reasonText : '这个操作暂时不可用'
  }
  if (binding.aliasBlocked) return `${binding.aliasNote !== '' ? binding.aliasNote : '当前身份不能执行写操作，请切换到招聘方身份'}`
  if (binding.pending) return '提交中…'
  return ''
}

/** build 失败 → 人读禁用原因（机器码留在数据层，文案只给 HR 能执行的下一步）。 */
function buildReasonOf(built: BodyBuildResult): string {
  if (built.ok) return ''
  return built.reasonText !== '' ? built.reasonText : '表单还没有填完整，请检查必填项'
}

/** P0 `stage/advance`：点击即提交 `{application_id}`（服务端按已发生事实推导目标阶段）。 */
function StageAdvanceForm({
  action,
  applicationId,
  aliasBlocked,
  aliasNote,
  pending,
  onRunAction,
}: {
  readonly action: ActionView | undefined
  readonly applicationId: string
  readonly aliasBlocked: boolean
  readonly aliasNote: string
  readonly pending: boolean
  readonly onRunAction: (action: ActionView, request: Readonly<Record<string, unknown>>) => void
}) {
  const [localError, setLocalError] = useState('')
  const built = buildStageAdvanceBody({ applicationId })
  const structural = structuralReason(action, { aliasBlocked, aliasNote, pending })
  const blockedReason = structural !== '' ? structural : buildReasonOf(built)
  const disabled = blockedReason !== ''
  return (
    <ActionCard actionKey="stage_advance" title="推进阶段（stage/advance）" available={!disabled} blockedReason={blockedReason}>
      <p className="rcw-dim rcw-tiny">
        服务端按已发生事实推导目标阶段（本表单只提交 application_id，不指定 to_stage；ADVANCED / NO_OP / BLOCKED 都是服务端业务结论）。
      </p>
      <button
        type="button"
        className="rcw-btn rcw-btn-blue"
        data-testid="stage-advance-submit"
        disabled={disabled}
        onClick={() => {
          if (!built.ok) {
            setLocalError(buildReasonOf(built))
            return
          }
          if (action === undefined) return
          setLocalError('')
          onRunAction(action, built.body)
        }}
      >
        {pending ? '提交中…' : '推进阶段'}
      </button>
      {localError !== '' ? (
        <p className="rcw-alert" data-testid="stage-advance-error" style={{ marginTop: 8 }}>
          {localError}
        </p>
      ) : null}
    </ActionCard>
  )
}

/** P0 `screening/decide`：结论 + 理由；facts 缺 → disabled + 精确原因（不发请求）。 */
function ScreeningForm({
  action,
  detail,
  decisionFacts,
  decisionFactsProbe,
  aliasBlocked,
  aliasNote,
  pending,
  factsBlockedReason,
  onRunAction,
  onScreeningEvaluate,
  evaluateDisabledReason,
  evaluatePending,
}: {
  readonly action: ActionView | undefined
  readonly detail: ApplicationDetailView | undefined
  readonly decisionFacts: DecisionFacts | undefined
  readonly decisionFactsProbe: 'READY' | 'MISSING' | 'ERROR' | 'LOADING' | undefined
  readonly aliasBlocked: boolean
  readonly aliasNote: string
  readonly pending: boolean
  readonly factsBlockedReason: string
  readonly onRunAction: (action: ActionView, request: Readonly<Record<string, unknown>>) => void
  readonly onScreeningEvaluate: (() => void) | undefined
  readonly evaluateDisabledReason: string
  readonly evaluatePending: boolean
}) {
  const [result, setResult] = useState<'ADVANCE' | 'HOLD' | 'WITHDRAW' | 'REJECT'>('HOLD')
  const [reason, setReason] = useState('')
  const [localError, setLocalError] = useState('')
  const applicationId = detail?.header.id ?? ''
  const needsEvaluation = result === 'ADVANCE' || result === 'REJECT'
  const blockers = screeningDecisionBlockers(decisionFacts ?? null, needsEvaluation)
  const structural = structuralReason(action, { aliasBlocked, aliasNote, pending })
  const blockedReasonParts = [
    structural,
    factsBlockedReason,
    blockers.length > 0 ? blockers.map(blockerTextOf).join('、') : '',
  ].filter((part) => part !== '')
  const blockedReason = blockedReasonParts.join('；')
  const disabled = blockedReason !== ''
  const evaluateBlocked = evaluateDisabledReason !== ''
  return (
    <ActionCard
      actionKey="screening_decide"
      title="记录初筛结论（screening/decide）"
      available={!disabled}
      blockedReason={blockedReason}
    >
      {factsBlockedReason !== '' || blockers.length > 0 ? (
        <p className="rcw-alert" data-testid="screening-disabled-reason" style={{ marginTop: 6 }}>
          {[factsBlockedReason, blockers.map(blockerTextOf).join('、')].filter((part) => part !== '').join('；')}
        </p>
      ) : null}
      <FormField label="结论（result）">
        <select
          className="rcw-select"
          data-testid="screening-result"
          value={result}
          onChange={(event) => setResult(event.target.value as 'ADVANCE' | 'HOLD' | 'WITHDRAW' | 'REJECT')}
        >
          <option value="ADVANCE">通过（ADVANCE）</option>
          <option value="HOLD">暂缓（HOLD）</option>
          <option value="WITHDRAW">撤回（WITHDRAW）</option>
          <option value="REJECT">不通过（REJECT）</option>
        </select>
      </FormField>
      <FormField label="理由（1..4000 字；REJECT 必须引到 rubric 维度 key）">
        <textarea
          data-testid="screening-reason"
          rows={3}
          style={FIELD_STYLE}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>
      <div className="rcw-chiprow" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="rcw-btn rcw-btn-blue"
          data-testid="screening-submit"
          disabled={disabled}
          onClick={() => {
            const built = buildScreeningDecisionBody({
              facts: decisionFacts ?? null,
              result,
              reason,
              applicationId,
            })
            if (!built.ok) {
              setLocalError(buildReasonOf(built))
              return
            }
            if (action === undefined) return
            setLocalError('')
            onRunAction(action, built.body)
          }}
        >
          {pending ? '提交中…' : '记录初筛结论'}
        </button>
        <button
          type="button"
          className="rcw-btn rcw-btn-soft"
          data-testid="screening-evaluate"
          disabled={evaluateBlocked || evaluatePending || onScreeningEvaluate === undefined}
          onClick={() => {
            if (evaluateBlocked || onScreeningEvaluate === undefined) return
            onScreeningEvaluate()
          }}
        >
          {evaluatePending ? '评估执行中…' : '执行初筛评估'}
        </button>
      </div>
      <p className="rcw-dim rcw-tiny" style={{ marginTop: 6 }} data-testid="screening-evaluate-pending">
        {evaluateBlocked ? evaluateDisabledReason : '执行初筛评估会真的写 screening_evaluation；成功后再 GET facts。'}
      </p>
      {localError !== '' ? (
        <p className="rcw-alert" data-testid="screening-error" style={{ marginTop: 8 }}>
          {localError}
        </p>
      ) : null}
    </ActionCard>
  )
}

/** P1 `interview/schedule` CREATE：轮次/开始/时长/面试官（候选来自 settings.hiringTeams）/幂等键。 */
function InterviewScheduleForm({
  action,
  detail,
  settings,
  aliasBlocked,
  aliasNote,
  pending,
  onRunAction,
}: {
  readonly action: ActionView | undefined
  readonly detail: ApplicationDetailView | undefined
  readonly settings: SettingsView | undefined
  readonly aliasBlocked: boolean
  readonly aliasNote: string
  readonly pending: boolean
  readonly onRunAction: (action: ActionView, request: Readonly<Record<string, unknown>>) => void
}) {
  const candidates = interviewerCandidates(settings)
  const existingRounds = detail?.interviews.map((interview) => interview.roundNo) ?? []
  const defaultRound = Math.min(20, Math.max(1, existingRounds.length === 0 ? 1 : Math.max(...existingRounds) + 1))
  const [roundNo, setRoundNo] = useState(String(defaultRound))
  const [start, setStart] = useState('')
  const [duration, setDuration] = useState('60')
  const [interviewerActorId, setInterviewerActorId] = useState(candidates[0]?.actorId ?? '')
  const [idempotencyKey] = useState(() => newIdempotencyKey())
  const [localError, setLocalError] = useState('')
  const structural = structuralReason(action, { aliasBlocked, aliasNote, pending })
  const candidateMissing = candidates.length === 0 ? '还没有可选的面试官：招聘团队里没有可用人员，请先在招聘设置里补上' : ''
  const blockedReason = [structural, candidateMissing].filter((part) => part !== '').join('；')
  const disabled = blockedReason !== ''
  return (
    <ActionCard
      actionKey="interview_schedule"
      title="安排面试（interview/schedule · CREATE）"
      available={!disabled}
      blockedReason={blockedReason}
    >
      <FormField label="轮次（1..20）">
        <input
          type="number"
          min={1}
          max={20}
          data-testid="schedule-round"
          style={FIELD_STYLE}
          value={roundNo}
          onChange={(event) => setRoundNo(event.target.value)}
        />
      </FormField>
      <FormField label="开始时间（datetime-local → 带偏移 ISO）">
        <input
          type="datetime-local"
          data-testid="schedule-start"
          style={FIELD_STYLE}
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </FormField>
      <FormField label="时长（15..480 分钟）">
        <input
          type="number"
          min={15}
          max={480}
          data-testid="schedule-duration"
          style={FIELD_STYLE}
          value={duration}
          onChange={(event) => setDuration(event.target.value)}
        />
      </FormField>
      <FormField label="面试官（来自招聘团队；值是 actorId）">
        <select
          className="rcw-select"
          data-testid="schedule-interviewer"
          value={interviewerActorId}
          onChange={(event) => setInterviewerActorId(event.target.value)}
        >
          {candidates.length === 0 ? <option value="">（没有可用候选人）</option> : null}
          {candidates.map((candidate) => (
            <option key={candidate.actorId} value={candidate.actorId}>
              {candidate.displayName}
              {candidate.teamName !== '' ? ` · ${candidate.teamName}` : ''}
              {candidate.teamRole !== '' ? ` · ${candidate.teamRole}` : ''}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="幂等键（前端生成并保留；重试复用同一 key）">
        <input type="text" data-testid="schedule-idempotency" style={FIELD_STYLE} value={idempotencyKey} readOnly />
      </FormField>
      <button
        type="button"
        className="rcw-btn rcw-btn-blue"
        data-testid="schedule-submit"
        disabled={disabled}
        onClick={() => {
          const built = buildInterviewScheduleBody({
            applicationId: detail?.header.id ?? '',
            roundNo: Number(roundNo),
            scheduledStartAt: toOffsetIso(start),
            durationMinutes: Number(duration),
            interviewers: interviewerActorId !== '' ? [{ actorId: interviewerActorId, requiredScorecard: true }] : [],
            idempotencyKey,
            timezone: 'Asia/Shanghai',
          })
          if (!built.ok) {
            setLocalError(buildReasonOf(built))
            return
          }
          if (action === undefined) return
          setLocalError('')
          onRunAction(action, built.body)
        }}
      >
        {pending ? '提交中…' : '安排面试'}
      </button>
      {localError !== '' ? (
        <p className="rcw-alert" data-testid="schedule-error" style={{ marginTop: 8 }}>
          {localError}
        </p>
      ) : null}
    </ActionCard>
  )
}

/** P1 `transcript/import`：人工粘贴正文；DEMO_SAMPLE = FIXTURE 演示文本（不得冒充 LIVE）。 */
function TranscriptImportForm({
  action,
  detail,
  aliasBlocked,
  aliasNote,
  pending,
  onRunAction,
}: {
  readonly action: ActionView | undefined
  readonly detail: ApplicationDetailView | undefined
  readonly aliasBlocked: boolean
  readonly aliasNote: string
  readonly pending: boolean
  readonly onRunAction: (action: ActionView, request: Readonly<Record<string, unknown>>) => void
}) {
  const choices = interviewChoices(detail)
  const [interviewId, setInterviewId] = useState(choices[0]?.interviewId ?? '')
  const [content, setContent] = useState('')
  const [sourceKind, setSourceKind] = useState<'PLATFORM_EXPORT' | 'DEMO_SAMPLE'>('DEMO_SAMPLE')
  const [fileName, setFileName] = useState('')
  const [language, setLanguage] = useState('zh')
  const [note, setNote] = useState('')
  const [localError, setLocalError] = useState('')
  const structural = structuralReason(action, { aliasBlocked, aliasNote, pending })
  const targetMissing = choices.length === 0 ? '这个申请还没有可关联的面试，请先安排面试' : ''
  const blockedReason = [structural, targetMissing].filter((part) => part !== '').join('；')
  const disabled = blockedReason !== ''
  return (
    <ActionCard
      actionKey="transcript_import"
      title="导入 / 关联 Transcript（transcript/import）"
      available={!disabled}
      blockedReason={blockedReason}
    >
      <FormField label="面试（转写只能挂到已绑定的面试）">
        <select
          className="rcw-select"
          data-testid="transcript-interview"
          value={interviewId}
          onChange={(event) => setInterviewId(event.target.value)}
        >
          {choices.length === 0 ? <option value="">（该申请没有面试）</option> : null}
          {choices.map((choice) => (
            <option key={choice.interviewId} value={choice.interviewId}>
              {choice.label}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label="来源（source_kind）"
        hint={
          sourceKind === 'DEMO_SAMPLE'
            ? 'DEMO_SAMPLE = 演示文本（provenance=FIXTURE，附 FIXTURE_CONTENT_NOT_LIVE 警告；不是真实平台导出件）'
            : 'PLATFORM_EXPORT = 平台导出件（provenance=LIVE，必须填导出文件名）'
        }
      >
        <select
          className="rcw-select"
          data-testid="transcript-source-kind"
          value={sourceKind}
          onChange={(event) => setSourceKind(event.target.value as 'PLATFORM_EXPORT' | 'DEMO_SAMPLE')}
        >
          <option value="DEMO_SAMPLE">DEMO_SAMPLE（FIXTURE 演示文本）</option>
          <option value="PLATFORM_EXPORT">PLATFORM_EXPORT（真实平台导出）</option>
        </select>
      </FormField>
      <FormField label="导出文件名（exported_file_name；PLATFORM_EXPORT 必填）">
        <input
          type="text"
          data-testid="transcript-file-name"
          style={FIELD_STYLE}
          value={fileName}
          onChange={(event) => setFileName(event.target.value)}
        />
      </FormField>
      <FormField label="正文（content，逐字节保存，1..400000 字符）">
        <textarea
          data-testid="transcript-content"
          rows={4}
          style={FIELD_STYLE}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </FormField>
      <FormField label="语言（language，默认 zh）">
        <input
          type="text"
          data-testid="transcript-language"
          style={FIELD_STYLE}
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        />
      </FormField>
      <FormField label="备注（note，≤500，人工追溯）">
        <input
          type="text"
          data-testid="transcript-note"
          style={FIELD_STYLE}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </FormField>
      <button
        type="button"
        className="rcw-btn rcw-btn-blue"
        data-testid="transcript-submit"
        disabled={disabled}
        onClick={() => {
          const built = buildTranscriptImportBody({
            interviewId,
            content,
            sourceKind,
            exportedFileName: fileName,
            language,
            note,
          })
          if (!built.ok) {
            setLocalError(buildReasonOf(built))
            return
          }
          if (action === undefined) return
          setLocalError('')
          onRunAction(action, built.body)
        }}
      >
        {pending ? '提交中…' : '导入 Transcript'}
      </button>
      {localError !== '' ? (
        <p className="rcw-alert" data-testid="transcript-error" style={{ marginTop: 8 }}>
          {localError}
        </p>
      ) : null}
    </ActionCard>
  )
}

/** P0 `decision/record`（facade）：scope/result/理由；summary 缺 → SUMMARY_MISSING disabled。 */
function DecisionRecordForm({
  decisionFacts,
  decisionFactsProbe,
  applicationId,
  aliasBlocked,
  aliasNote,
  pending,
  onDecisionRecord,
}: {
  readonly decisionFacts: DecisionFacts | undefined
  readonly decisionFactsProbe: 'READY' | 'MISSING' | 'ERROR' | 'LOADING' | undefined
  readonly applicationId: string
  readonly aliasBlocked: boolean
  readonly aliasNote: string
  readonly pending: boolean
  readonly onDecisionRecord: ((request: Readonly<Record<string, unknown>>) => void) | undefined
}) {
  const [scope, setScope] = useState<'STAGE' | 'FINAL'>('STAGE')
  const [result, setResult] = useState<'ADVANCE' | 'HOLD' | 'REJECT'>('ADVANCE')
  const [reason, setReason] = useState('')
  const [localError, setLocalError] = useState('')
  const factsProbeReason =
    decisionFactsProbe === 'MISSING'
      ? '还不能记录决策：决策依据暂时读不到，请稍后重试'
      : decisionFactsProbe === 'ERROR'
        ? '决策依据读取失败，请稍后重试；如果一直失败请联系管理员'
        : decisionFactsProbe === 'LOADING'
          ? '正在读取决策依据…'
          : decisionFacts === undefined
            ? '还不能记录决策：决策依据还没有读取'
            : ''
  const blockers = decisionRecordBlockers(decisionFacts ?? null)
  const structural = [
    aliasBlocked ? `${aliasNote !== '' ? aliasNote : '当前身份不能执行写操作，请切换到招聘方身份'}` : '',
    pending ? '提交中…' : '',
    onDecisionRecord === undefined ? '当前页面版本没有提供「记录正式决策」操作' : '',
  ].filter((part) => part !== '')
  const blockedReasonParts = [
    ...structural,
    factsProbeReason,
    blockers.length > 0 ? blockers.map(blockerTextOf).join('、') : '',
  ].filter((part) => part !== '')
  const blockedReason = blockedReasonParts.join('；')
  const disabled = blockedReason !== ''
  return (
    <ActionCard
      actionKey="decision_record"
      title="记录正式决策（decision/record · facade）"
      available={!disabled}
      blockedReason={blockedReason}
    >
      {blockedReason !== '' ? (
        <p className="rcw-alert" data-testid="decision-disabled-reason" style={{ marginTop: 6 }}>
          {blockedReason}
        </p>
      ) : null}
      <FormField label="决策范围（decision_scope）">
        <select
          className="rcw-select"
          data-testid="decision-scope"
          value={scope}
          onChange={(event) => setScope(event.target.value as 'STAGE' | 'FINAL')}
        >
          <option value="STAGE">阶段决策（STAGE）</option>
          <option value="FINAL">最终决策（FINAL）</option>
        </select>
      </FormField>
      <FormField label="结论（result；WITHDRAW/HIRED 不在 facade 封闭集）">
        <select
          className="rcw-select"
          data-testid="decision-result"
          value={result}
          onChange={(event) => setResult(event.target.value as 'ADVANCE' | 'HOLD' | 'REJECT')}
        >
          <option value="ADVANCE">通过（ADVANCE）</option>
          <option value="HOLD">暂缓（HOLD）</option>
          <option value="REJECT">不通过（REJECT）</option>
        </select>
      </FormField>
      <FormField label="理由（1..4000 字）">
        <textarea
          data-testid="decision-reason"
          rows={3}
          style={FIELD_STYLE}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>
      <button
        type="button"
        className="rcw-btn rcw-btn-blue"
        data-testid="decision-submit"
        disabled={disabled}
        onClick={() => {
          const built = buildDecisionRecordBody({
            facts: decisionFacts ?? null,
            applicationId,
            scope,
            result,
            reason,
          })
          if (!built.ok) {
            setLocalError(buildReasonOf(built))
            return
          }
          if (onDecisionRecord === undefined) return
          setLocalError('')
          onDecisionRecord(built.body)
        }}
      >
        {pending ? '提交中…' : '记录决策'}
      </button>
      {localError !== '' ? (
        <p className="rcw-alert" data-testid="decision-error" style={{ marginTop: 8 }}>
          {localError}
        </p>
      ) : null}
    </ActionCard>
  )
}

/** `action-result` 读回区：只显示服务端 readback/决策/评估的键值行（键/值原样，不做业务推断）。 */
function ActionResultPanel({ outcomes }: { readonly outcomes: ReadonlyArray<ActionOutcome> }) {
  return (
    <div className="rcw-smallcard" style={{ marginTop: 14 }} data-testid="action-result" data-has-outcome={outcomes.length > 0 ? 'true' : 'false'}>
      <div className="rcw-chiprow">
        <strong>写动作结果 · 服务端读回</strong>
        <Chip tone="gray">成功事实只认 readback + 重新 GET</Chip>
      </div>
      {outcomes.length === 0 ? (
        <p className="rcw-dim rcw-tiny" style={{ marginTop: 6 }}>
          尚未执行写动作。
        </p>
      ) : (
        outcomes.map((outcome, index) => {
          const lines = actionResultLines(outcome)
          const readbackShown = outcome.envelope !== null && outcome.envelope.readback !== null
          const advice = outcome.error !== null ? describeActionError(outcome.error.code, outcome.error.reasonCode) : ''
          return (
            <div
              key={`${outcome.key}-${String(index)}`}
              data-testid="action-result-item"
              data-action-key={outcome.key}
              data-accepted={outcome.accepted ? 'true' : 'false'}
              data-has-readback={readbackShown ? 'true' : 'false'}
              style={{ marginTop: 10, borderTop: index === 0 ? 'none' : '1px dashed #e6ebf2', paddingTop: index === 0 ? 0 : 10 }}
            >
              <div className="rcw-chiprow">
                <Chip tone="blue">动作 · {outcome.key}</Chip>
                <Chip tone={outcome.accepted ? 'blue' : 'red'}>HTTP {outcome.status}</Chip>
                {readbackShown ? (
                  <Chip tone="green">readback 已读回</Chip>
                ) : outcome.accepted ? (
                  <Chip tone="amber">2xx 但无 readback（不当作成功）</Chip>
                ) : (
                  <Chip tone="red">服务端拒绝</Chip>
                )}
              </div>
              {outcome.error !== null ? (
                <div style={{ marginTop: 6 }}>
                  <p className="rcw-alert" data-testid="action-result-error">
                    {outcome.error.code !== '' ? `${outcome.error.code}/` : ''}
                    {outcome.error.reasonCode !== '' ? outcome.error.reasonCode : ''}：{outcome.error.message}
                  </p>
                  {advice !== '' ? (
                    <p className="rcw-dim rcw-tiny" data-testid="action-result-advice">
                      补救：{advice}
                    </p>
                  ) : null}
                  {outcome.error.rawBody !== '' ? (
                    <pre className="rcw-mono rcw-tiny" data-testid="action-result-raw">
                      {outcome.error.rawBody}
                    </pre>
                  ) : null}
                </div>
              ) : null}
              {lines.length > 0 ? (
                <div style={{ marginTop: 6 }}>
                  {lines.map((line) => (
                    <div className="rcw-fieldrow" key={line.key} data-readback-key={line.key}>
                      <span className="rcw-fieldkey">
                        {line.label}
                        {line.label !== line.key ? <span className="rcw-mono rcw-tiny"> · {line.key}</span> : null}
                      </span>
                      <span className="rcw-fieldval rcw-mono">{line.value}</span>
                    </div>
                  ))}
                </div>
              ) : outcome.accepted ? (
                <p className="rcw-dim rcw-tiny" style={{ marginTop: 6 }}>
                  服务端 HTTP 2xx，但信封里没有可展示的 readback —— 不当作成功（界面不会用本地状态代替读回）。
                </p>
              ) : null}
              {outcome.bodyText !== '' && outcome.error === null ? (
                <pre className="rcw-mono rcw-tiny" data-testid="action-result-body">
                  {outcome.bodyText}
                </pre>
              ) : null}
            </div>
          )
        })
      )}
    </div>
  )
}

/**
 * 申请详情视图。
 * @param props - 见 {@link ApplicationDetailProps}。
 * @returns 详情页 JSX（结论 + 写动作表单 + 渐进展开 + aside）。
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
  const applicationId = header?.id ?? ''
  const pendingKey = props.pendingActionKey
  // 本地写结果（evaluate / facade 由 workspace 回调注入；readback 只来自服务端响应）。
  const [localOutcome, setLocalOutcome] = useState<ActionOutcome | undefined>(undefined)
  const outcomes: ActionOutcome[] = []
  if (props.actionOutcome !== undefined) outcomes.push(props.actionOutcome)
  if (localOutcome !== undefined) outcomes.push(localOutcome)

  const factsProbeReason =
    props.decisionFactsProbe === 'MISSING'
      ? '还不能执行初筛评估：决策依据暂时读不到，请稍后重试'
      : props.decisionFactsProbe === 'ERROR'
        ? '决策依据读取失败，请稍后重试；如果一直失败请联系管理员'
        : props.decisionFactsProbe === 'LOADING'
          ? '正在读取决策依据…'
          : props.decisionFacts === undefined
            ? '还不能执行初筛评估：决策依据还没有读取'
            : ''
  const evaluationPresent = (props.decisionFacts?.screeningEvaluation ?? null) !== null
  const evaluateDisabledReason = [
    props.aliasBlocked ? '当前身份不能执行写操作，请切换到招聘方身份' : '',
    props.onScreeningEvaluate === undefined ? '当前页面版本没有提供「执行初筛评估」操作' : '',
    factsProbeReason,
    evaluationPresent ? '已经有初筛评估，不需要重复执行' : '',
    pendingKey === 'screening_evaluate' ? '提交中…' : '',
  ].filter((part) => part !== '')

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
              {actionList.length === 0 ? (
                <span className="rcw-dim rcw-tiny">当前申请没有可用的写操作。</span>
              ) : (
                actionList.map((action) => (
                  <Chip
                    key={action.key}
                    tone={action.available ? 'blue' : 'gray'}
                    testid={`detail-action-${action.key}`}
                    title={action.available ? '可执行；点击后由你确认并提交' : action.reasonText !== '' ? action.reasonText : '暂不可用'}
                  >
                    {/* O6：只给 HR 可执行的结论，不展示 seam / 机器码（结构化字段仍在 action 数据层）。 */}
                    {action.label} · {action.available ? '可执行' : '暂不可用'}
                  </Chip>
                ))
              )}
            </div>

            <StageAdvanceForm
              action={props.actions['stage_advance']}
              applicationId={applicationId}
              aliasBlocked={props.aliasBlocked}
              aliasNote={props.aliasNote}
              pending={pendingKey === 'stage_advance'}
              onRunAction={props.onRunAction}
            />
            <ScreeningForm
              action={props.actions['screening_decide']}
              detail={detail}
              decisionFacts={props.decisionFacts}
              decisionFactsProbe={props.decisionFactsProbe}
              aliasBlocked={props.aliasBlocked}
              aliasNote={props.aliasNote}
              pending={pendingKey === 'screening_decide'}
              factsBlockedReason={factsProbeReason}
              onRunAction={props.onRunAction}
              onScreeningEvaluate={props.onScreeningEvaluate}
              evaluateDisabledReason={evaluateDisabledReason.join('；')}
              evaluatePending={pendingKey === 'screening_evaluate'}
            />
            <DecisionRecordForm
              decisionFacts={props.decisionFacts}
              decisionFactsProbe={props.decisionFactsProbe}
              applicationId={applicationId}
              aliasBlocked={props.aliasBlocked}
              aliasNote={props.aliasNote}
              pending={pendingKey === 'decision_record_facade'}
              onDecisionRecord={props.onDecisionRecord}
            />
            <InterviewScheduleForm
              action={props.actions['interview_schedule']}
              detail={detail}
              settings={props.settings}
              aliasBlocked={props.aliasBlocked}
              aliasNote={props.aliasNote}
              pending={pendingKey === 'interview_schedule'}
              onRunAction={props.onRunAction}
            />
            <TranscriptImportForm
              action={props.actions['transcript_import']}
              detail={detail}
              aliasBlocked={props.aliasBlocked}
              aliasNote={props.aliasNote}
              pending={pendingKey === 'transcript_import'}
              onRunAction={props.onRunAction}
            />

            <ActionResultPanel outcomes={outcomes} />

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
                <small>面评进度（跨轮合计）</small>
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
            <LazySection title="面试排期与状态（含本轮重点）" testid="section-interviews" available={detail !== undefined}>
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
