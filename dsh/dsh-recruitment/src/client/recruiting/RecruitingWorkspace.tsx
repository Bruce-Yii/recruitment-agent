// 招聘工作区（W2）主视图：岗位侧栏 / 选择器 + 岗位头卡（业务结论 + 下一步）+ 申请列表 +
// 招聘设置入口（只读）。申请详情在 `application-detail.tsx`（点击行进入，返回总览）。
//
// 契约（`work/d5/CLIENT-CONTRACT.md` §2 / `work/d5/w2/CONTRACT.md` §3）：
//   · props 严格 `{ sessionId, alias }`，视图**不读 localStorage**、不从 URL 取业务参数；
//   · 每个视图挂载即 GET；刷新 / 动作成功后重新 GET 服务端（`reload()`），不用本地状态伪造业务事实；
//   · 写按钮只读 `overview.actions` 的可用性；不可用 → disabled +「待后端接入（pending: <code>）」，
//     点击不发请求；可用 → POST `actions[key].seam`，失败显示服务端 `{error:{code,reason_code,message}}` 原文；
//   · `alias !== 'recruiter'` 时显示只读提示并禁用写动作（不伪造权限），只读浏览不崩、不空白。
//
// DOM 证据钩子：根 `data-testid="recruiting-workspace" data-view="recruiting"`；
// 岗位行 `job-row-<id>`；申请行 `application-row-<id>`；结论区 `next-step`；
// 写按钮 `action-<key>`（带 `data-available` / `data-pending`）。

import { useState } from 'react'
import { useApplicationDetail, useJobDetail, useWorkspaceOverview, postActionSeam, type RecruitingErrorInfo } from './use-recruiting.ts'
import type {
  ActionView,
  ApplicationRowView,
  JobDetailView,
  JobView,
  NextStepView,
  RecruitingOverviewView,
  SettingsView,
} from './view-model.ts'
import { splitSidebarJobs } from './view-model.ts'
import {
  ActionButton,
  Card,
  Chip,
  EmptyState,
  ErrorAlert,
  KeyValue,
  Metric,
  NextStepPanel,
  SectionHead,
  SourceBox,
  ThreeDimBadges,
} from './parts.tsx'
import { ApplicationDetail } from './application-detail.tsx'
import { RECRUITING_CSS, ROOT_STYLE, STYLE_ELEMENT_KEY, chipClass } from './styles.ts'

/** 工作区 props（**必须与 `CLIENT-CONTRACT.md` 完全一致**）。 */
export interface WorkspaceProps {
  readonly sessionId: string
  readonly alias: 'recruiter' | 'interviewer_a' | 'interviewer_b'
}

/** 空下一步（服务端没给时用它渲染 fallback，而不是编造结论）。 */
const EMPTY_STEP: NextStepView = {
  code: '',
  label: '',
  kind: '',
  kindLabel: '',
  tone: 'gray',
  hasStep: false,
}

/** 申请列表筛选（纯本地视图筛选，不写存储）。 */
type ApplicationFilter = 'all' | 'screening' | 'interviewing' | 'other'

/** 动作反馈（2xx 只代表"服务端受理"，真正事实以 reload 后的服务端数据为准）。 */
interface ActionFeedback {
  readonly tone: 'ok' | 'error'
  readonly title: string
  readonly message: string
  readonly rawBody: string
}

/** 申请列表行。 */
function ApplicationRow({
  row,
  onOpen,
}: {
  readonly row: ApplicationRowView
  readonly onOpen: (applicationId: string) => void
}) {
  return (
    <button
      type="button"
      className="rcw-appitem"
      data-testid={`application-row-${row.id}`}
      data-application-id={row.id}
      data-stage={row.stageCode}
      data-next-step={row.nextStep.code}
      data-filter-kind={row.filterKind}
      onClick={() => onOpen(row.id)}
      title={`打开 ${row.candidateName} 的申请详情`}
    >
      <span className="rcw-av">{row.candidateInitial}</span>
      <span className="rcw-rowmain">
        <span className="rcw-rowtitle">
          {row.candidateName}
          <span className="rcw-rowjob">{row.jobTitle}</span>
        </span>
        <span className="rcw-rowmeta">
          <Chip tone={row.stageTone} testid={`application-row-${row.id}-stage`}>
            阶段 · {row.stageLabel}
          </Chip>
          <span data-testid={`application-row-${row.id}-material`}>材料 · {row.materialSummary}</span>
          <span data-testid={`application-row-${row.id}-screening`}>初筛 · {row.screeningSummary}</span>
          <span data-testid={`application-row-${row.id}-interviews`}>面试 · {row.interviewSummary}</span>
          <span data-testid={`application-row-${row.id}-scorecards`}>面评 · {row.scorecardProgress.summaryText}</span>
          <span data-testid={`application-row-${row.id}-transcript`}>转写 · {row.transcriptSummary}</span>
        </span>
      </span>
      <span className="rcw-rowend">
        <Chip tone={row.nextStep.tone} testid={`application-row-${row.id}-next-step`}>
          {row.nextStep.hasStep ? (row.nextStep.label !== '' ? row.nextStep.label : row.nextStep.code) : '无下一步'}
        </Chip>
        <span className="rcw-chev">›</span>
      </span>
    </button>
  )
}

/** 岗位头卡（含岗位选择器、指标、rubric、投递渠道、**唯一一份**岗位下一步、动作区）。 */
function JobHero({
  job,
  jobs,
  overview,
  onSelectJob,
  onToggleJobDetail,
  jobDetailOpen,
  actions,
  pendingActionKey,
  onRunAction,
  aliasBlocked,
  aliasNote,
  onOpenSettings,
}: {
  readonly job: JobView | undefined
  readonly jobs: ReadonlyArray<JobView>
  readonly overview: RecruitingOverviewView
  readonly onSelectJob: (jobId: string) => void
  readonly onToggleJobDetail: () => void
  readonly jobDetailOpen: boolean
  readonly actions: Readonly<Record<string, ActionView>>
  readonly pendingActionKey: string
  readonly onRunAction: (action: ActionView) => void
  readonly aliasBlocked: boolean
  readonly aliasNote: string
  readonly onOpenSettings: () => void
}) {
  if (job === undefined) {
    return (
      <Card className="rcw-hero" testid="job-hero">
        <span className="rcw-cap">当前招聘岗位</span>
        <h2 style={{ marginTop: 6 }}>没有可展示的岗位</h2>
        <p className="rcw-sub">服务端 overview 的 jobs 为空：招聘数据可能尚未接入，界面不编造岗位。</p>
        <NextStepPanel step={EMPTY_STEP} scope="job" fallback="服务端未返回岗位" />
      </Card>
    )
  }
  const rubricAction = actions.rubric_approve
  const currentStageRow =
    job.applicationCounts.byStage.find((row) => row.code === overview.applications[0]?.stageCode) ?? undefined
  return (
    <Card className="rcw-hero" testid="job-hero">
      <div className="rcw-hero-top">
        <div className="rcw-main">
          <span className="rcw-cap">当前招聘岗位</span>
          <h2>{job.title}</h2>
          <p className="rcw-sub">
            {job.departmentName !== '' ? job.departmentName : '（未提供部门）'}
            {job.code !== '' ? ` · ${job.code}` : ''}
            {job.versionText !== '' ? ` · 岗位版本 ${job.versionText}` : ''}
          </p>
        </div>
        <select
          className="rcw-select"
          data-testid="job-select"
          aria-label="选择岗位"
          value={job.id}
          onChange={(event) => onSelectJob(event.target.value)}
        >
          {jobs.map((item, index) => (
            <option key={item.rowKey !== '' ? item.rowKey : `job-${String(index)}`} value={item.id}>
              {item.title}
              {item.statusLabel !== '' ? `（${item.statusLabel}）` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="rcw-chiprow" style={{ marginTop: 12 }}>
        <Chip tone={job.statusTone} testid="job-status">
          岗位状态 · {job.statusLabel}
        </Chip>
        {job.rubric !== null ? (
          <Chip tone={job.rubric.tone} testid="job-rubric">
            {job.rubric.summaryText}
          </Chip>
        ) : (
          <Chip tone="gray" testid="job-rubric">
            未关联 rubric
          </Chip>
        )}
        {job.postings.map((posting) => (
          <Chip key={posting.id} tone={posting.tone} title={posting.externalUrl !== '' ? posting.externalUrl : undefined}>
            渠道 · {posting.channelName !== '' ? posting.channelName : '（未命名渠道）'} · {posting.statusLabel}
          </Chip>
        ))}
      </div>

      <div className="rcw-metrics">
        <Metric value={job.applicationCounts.total} label="该岗位收到的申请" testid="job-metric-total" />
        <Metric value={job.applicationCounts.active} label="推进中的申请" testid="job-metric-active" />
        <Metric
          value={overview.counts.awaitingScreening}
          label="待初筛（全工作区）"
          testid="job-metric-awaiting-screening"
        />
        <Metric value={overview.counts.interviewsScheduled} label="已排期面试（全工作区）" testid="job-metric-interviews" />
      </div>

      {job.applicationCounts.byStage.length > 0 ? (
        <div className="rcw-stagebar" data-testid="job-stage-counts">
          {job.applicationCounts.byStage.map((row) => (
            <Chip key={row.code} tone={row.code === currentStageRow?.code ? 'blue' : 'gray'}>
              {row.label} · {row.count}
            </Chip>
          ))}
        </div>
      ) : null}

      {/* 岗位级业务结论 + 下一步：本视图唯一一份（aside / 列表都不复述） */}
      <NextStepPanel step={job.nextStep} scope="job" fallback="服务端未给该岗位下一步" />

      <div className="rcw-inlineactions" data-testid="job-actions">
        {rubricAction !== undefined ? (
          <ActionButton
            action={rubricAction}
            pending={pendingActionKey === rubricAction.key}
            aliasBlocked={aliasBlocked}
            aliasNote={aliasNote}
            onRun={onRunAction}
          />
        ) : null}
        <button type="button" className="rcw-btn" data-testid="toggle-job-detail" onClick={onToggleJobDetail}>
          {jobDetailOpen ? '收起岗位版本与 rubric' : '查看岗位版本与 rubric'}
        </button>
        <button type="button" className="rcw-btn rcw-btn-soft" data-testid="open-settings" onClick={onOpenSettings}>
          招聘设置（只读）
        </button>
      </div>

      <div className="rcw-nextstep-meta" style={{ marginTop: 10 }}>
        <span>岗位创建：{job.createdAtText !== '' ? job.createdAtText : '—'}</span>
        <span>状态变更：{job.statusChangedAtText !== '' ? job.statusChangedAtText : '—'}</span>
        <span>岗位 id：<span className="rcw-code">{job.id !== '' ? job.id : '—'}</span></span>
      </div>
    </Card>
  )
}

/** 岗位版本 / rubric / 描述（点击头卡按钮时懒加载 `jobs/:id`）。 */
function JobDetailCard({
  jobDetail,
  loading,
  error,
  onRetry,
  onClose,
}: {
  readonly jobDetail: JobDetailView | undefined
  readonly loading: boolean
  readonly error: RecruitingErrorInfo | undefined
  readonly onRetry: () => void
  readonly onClose: () => void
}) {
  return (
    <Card className="rcw-detailmain" style={{ marginTop: 14 }} testid="job-detail">
      <div className="rcw-sectionhead" style={{ marginTop: 0 }}>
        <h2>岗位详情 · 版本与 rubric</h2>
        <button type="button" className="rcw-btn rcw-btn-sm" data-testid="close-job-detail" onClick={onClose}>
          收起
        </button>
      </div>
      {error !== undefined ? (
        <ErrorAlert title="岗位详情读取失败" message={error.message} rawBody={error.rawBody} onRetry={onRetry} />
      ) : null}
      {loading && jobDetail === undefined ? <p className="rcw-loading">正在读取岗位详情…</p> : null}
      {jobDetail !== undefined ? (
        <>
          <div className="rcw-chiprow">
            <Chip tone={jobDetail.job.statusTone}>岗位状态 · {jobDetail.job.statusLabel}</Chip>
            {jobDetail.rubric !== null ? (
              <Chip tone={jobDetail.rubric.approved ? 'green' : 'amber'}>
                rubric r{String(jobDetail.rubric.versionNo)} · {jobDetail.rubric.dimensions.length} 维度 ·{' '}
                {jobDetail.rubric.approved ? '已批准' : '未批准'}
              </Chip>
            ) : (
              <Chip tone="gray">未关联 rubric</Chip>
            )}
            <ThreeDimBadges labels={jobDetail.labels} testid="job-detail-labels" />
          </div>
          <div className="rcw-subhead">
            <h3>岗位版本</h3>
            <span className="rcw-dim rcw-tiny">共 {jobDetail.versions.length} 个版本</span>
          </div>
          {jobDetail.versions.length === 0 ? (
            <EmptyState>服务端没有返回岗位版本。</EmptyState>
          ) : (
            <div className="rcw-tablewrap">
              <table className="rcw-table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>payload hash</th>
                    <th>创建时间</th>
                    <th>批准</th>
                  </tr>
                </thead>
                <tbody>
                  {jobDetail.versions.map((version) => (
                    <tr key={version.id !== '' ? version.id : `version-${String(version.versionNo)}`}>
                      <td>r{version.versionNo}</td>
                      <td className="rcw-mono">{version.payloadHashText !== '' ? version.payloadHashText : '—'}</td>
                      <td>{version.createdAtText !== '' ? version.createdAtText : '—'}</td>
                      <td>{version.approved ? '已批准' : '未批准'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="rcw-subhead">
            <h3>Rubric 维度</h3>
          </div>
          {jobDetail.rubric === null || jobDetail.rubric.dimensions.length === 0 ? (
            <EmptyState>该岗位没有可用的 rubric 维度。</EmptyState>
          ) : (
            jobDetail.rubric.dimensions.map((dimension) => (
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
                </div>
              </div>
            ))
          )}
          {jobDetail.requirementsMd !== '' ? (
            <div style={{ marginTop: 14 }}>
              <div className="rcw-cap">岗位要求（服务端 markdown 原文）</div>
              <SourceBox testid="job-requirements">{jobDetail.requirementsMd}</SourceBox>
            </div>
          ) : null}
          {jobDetail.descriptionMd !== '' ? (
            <div style={{ marginTop: 14 }}>
              <div className="rcw-cap">岗位描述（服务端 markdown 原文）</div>
              <SourceBox testid="job-description">{jobDetail.descriptionMd}</SourceBox>
            </div>
          ) : null}
          <div className="rcw-subhead">
            <h3>该岗位的申请</h3>
            <span className="rcw-dim rcw-tiny">{jobDetail.applications.length} 条</span>
          </div>
          {jobDetail.applications.length === 0 ? (
            <EmptyState>该岗位还没有申请。</EmptyState>
          ) : (
            jobDetail.applications.map((row) => (
              <div className="rcw-fieldrow" key={row.rowKey}>
                <span className="rcw-fieldkey">
                  {row.candidateName}
                  {row.jobTitle !== '' ? ` · ${row.jobTitle}` : ''}
                </span>
                <span className="rcw-fieldval">
                  <span className={chipClass(row.stageTone)}>{row.stageLabel}</span>
                </span>
              </div>
            ))
          )}
        </>
      ) : null}
    </Card>
  )
}

/** 右侧岗位侧栏：只把 OPEN / DRAFT 放进"正在招聘"，其余（归档/关闭/暂停）收进折叠区。 */
function JobSidebar({
  jobs,
  selectedJobId,
  onSelectJob,
}: {
  readonly jobs: ReadonlyArray<JobView>
  readonly selectedJobId: string
  readonly onSelectJob: (jobId: string) => void
}) {
  const { active, archived } = splitSidebarJobs(jobs)
  const renderRow = (job: JobView) => (
    <button
      key={job.rowKey}
      type="button"
      className={`rcw-jobrow ${job.id === selectedJobId ? 'rcw-jobrow-active' : ''}`.trim()}
      data-testid={`job-row-${job.id}`}
      data-selected={job.id === selectedJobId ? 'true' : 'false'}
      onClick={() => onSelectJob(job.id)}
    >
      <span className="rcw-av">{job.title.slice(0, 1)}</span>
      <span className="rcw-rowmain">
        <strong>{job.title}</strong>
        <small>
          {job.departmentName !== '' ? `${job.departmentName} · ` : ''}
          {job.applicationCounts.total} 份申请 · {job.applicationCounts.active} 份推进中
        </small>
      </span>
      <Chip tone={job.statusTone}>{job.statusLabel}</Chip>
    </button>
  )
  return (
    <Card className="rcw-asidecard" testid="job-sidebar">
      <h2>正在招聘的岗位</h2>
      {active.length === 0 ? (
        <EmptyState>当前没有在招 / 草案岗位。</EmptyState>
      ) : (
        <div className="rcw-joblist" data-testid="active-job-list">
          {active.map(renderRow)}
        </div>
      )}
      {archived.length > 0 ? (
        <details className="rcw-disclosure" style={{ marginTop: 10, padding: '10px 12px' }} data-testid="archived-jobs">
          <summary>已归档 / 已关闭岗位（{archived.length}）</summary>
          <div className="rcw-joblist" style={{ marginTop: 8 }}>
            {archived.map(renderRow)}
          </div>
        </details>
      ) : null}
    </Card>
  )
}

/** 需要你处理（只显示按 kind 的聚合计数；逐条结论在申请行 / 详情里各出现一次）。 */
function AttentionCard({ overview }: { readonly overview: RecruitingOverviewView }) {
  const totals = overview.nextStepTotals
  return (
    <Card className="rcw-asidecard" testid="attention-card">
      <h2>需要你处理</h2>
      <div className="rcw-kv">
        <span className="rcw-k">需要人工处理</span>
        <span className="rcw-v">
          <Chip tone={totals.human > 0 ? 'amber' : 'gray'} testid="attention-human">
            {totals.human} 条
          </Chip>
        </span>
      </div>
      <div className="rcw-kv">
        <span className="rcw-k">等待中</span>
        <span className="rcw-v">
          <Chip tone="gray" testid="attention-wait">
            {totals.wait} 条
          </Chip>
        </span>
      </div>
      <div className="rcw-kv">
        <span className="rcw-k">进行中</span>
        <span className="rcw-v">
          <Chip tone="blue" testid="attention-info">
            {totals.info} 条
          </Chip>
        </span>
      </div>
      {totals.missing > 0 ? (
        <p className="rcw-muted rcw-tiny" style={{ marginTop: 8 }}>
          有 {totals.missing} 条申请没有服务端下一步（界面不推断）。
        </p>
      ) : null}
      <p className="rcw-muted rcw-tiny" style={{ marginTop: 8 }}>
        逐条结论只在申请行 / 申请详情出现一次，这里只给聚合计数。
      </p>
    </Card>
  )
}

/** 招聘概况（全部来自服务端 counts 聚合）。 */
function CountsCard({ overview }: { readonly overview: RecruitingOverviewView }) {
  const counts = overview.counts
  return (
    <Card className="rcw-asidecard" testid="counts-card">
      <h2>招聘概况</h2>
      <KeyValue label="岗位（招聘中 / 总数）" value={`${String(counts.jobsOpen)} / ${String(counts.jobsTotal)}`} />
      <KeyValue
        label="申请（推进中 / 总数）"
        value={`${String(counts.applicationsActive)} / ${String(counts.applicationsTotal)}`}
      />
      <KeyValue label="待初筛" value={String(counts.awaitingScreening)} />
      <KeyValue label="面试中" value={String(counts.interviewing)} />
      <KeyValue label="待决策" value={String(counts.awaitingDecision)} />
      <KeyValue label="已排期面试" value={String(counts.interviewsScheduled)} />
      <KeyValue
        label="面评（已提交 / 必需）"
        value={`${String(counts.scorecardsSubmittedTotal)} / ${String(counts.scorecardsRequiredTotal)}`}
      />
      <KeyValue
        label="Transcript（就绪 / 处理中）"
        value={`${String(counts.transcriptsReady)} / ${String(counts.transcriptsPending)}`}
      />
      {counts.byStage.length > 0 ? (
        <div className="rcw-chiprow" style={{ marginTop: 10 }}>
          {counts.byStage.map((row) => (
            <Chip key={row.code} tone="gray">
              {row.label} · {row.count}
            </Chip>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

/** 招聘设置入口（只读数据；写动作不可用 → 禁用按钮 + pending 文案）。 */
function SettingsEntryCard({
  overview,
  writeAction,
  onOpenSettings,
  pendingActionKey,
  onRunAction,
  aliasBlocked,
  aliasNote,
}: {
  readonly overview: RecruitingOverviewView
  readonly writeAction: ActionView | undefined
  readonly onOpenSettings: () => void
  readonly pendingActionKey: string
  readonly onRunAction: (action: ActionView) => void
  readonly aliasBlocked: boolean
  readonly aliasNote: string
}) {
  const { settings } = overview
  return (
    <Card className="rcw-asidecard" testid="settings-entry">
      <h2>招聘设置</h2>
      <p className="rcw-muted rcw-tiny" data-testid="settings-entry-note">
        {settings.entry.note !== '' ? settings.entry.note : '设置入口没有附加说明。'}
      </p>
      <div style={{ marginTop: 8 }}>
        <KeyValue
          label="阶段目录版本"
          value={settings.stageCatalog !== null ? `v${String(settings.stageCatalog.versionNo)}` : ''}
        />
        <KeyValue label="业务配置项" value={`${String(settings.configs.length)} 项`} />
        <KeyValue label="部门" value={`${String(settings.departments.length)} 个`} />
        <KeyValue label="招聘团队" value={`${String(settings.hiringTeams.length)} 个`} />
      </div>
      <div className="rcw-inlineactions">
        <button type="button" className="rcw-btn rcw-btn-soft" data-testid="open-settings-from-card" onClick={onOpenSettings}>
          查看只读设置
        </button>
        {writeAction !== undefined ? (
          <ActionButton
            action={writeAction}
            pending={pendingActionKey === writeAction.key}
            aliasBlocked={aliasBlocked}
            aliasNote={aliasNote}
            onRun={onRunAction}
          />
        ) : null}
      </div>
      {settings.entry.available && settings.entry.href !== '' ? (
        <p className="rcw-tiny" style={{ marginTop: 8 }}>
          服务端声明设置页已接线：<span className="rcw-mono">{settings.entry.href}</span>
        </p>
      ) : null}
    </Card>
  )
}

/** 只读设置视图（stage catalog / configs / departments / hiring teams）。 */
function SettingsPanel({
  overview,
  onBack,
  pendingActionKey,
  onRunAction,
  aliasBlocked,
  aliasNote,
}: {
  readonly overview: RecruitingOverviewView
  readonly onBack: () => void
  readonly pendingActionKey: string
  readonly onRunAction: (action: ActionView) => void
  readonly aliasBlocked: boolean
  readonly aliasNote: string
}) {
  const settings: SettingsView = overview.settings
  const writeAction = overview.actions.recruiting_settings_write
  return (
    <>
      <div className="rcw-headline">
        <div className="rcw-headline-left">
          <button type="button" className="rcw-back" data-testid="settings-back" onClick={onBack}>
            ← 返回招聘总览
          </button>
          <span className="rcw-cap">RECRUITMENT CONFIGURATION · READ ONLY</span>
          <h1>招聘设置</h1>
          <div className="rcw-sub">{settings.entry.note !== '' ? settings.entry.note : '只读展示当前生效的招聘配置。'}</div>
        </div>
        <div className="rcw-headline-right">
          {settings.stageCatalog !== null ? (
            <Chip tone="blue" testid="settings-catalog-version">
              阶段目录 v{String(settings.stageCatalog.versionNo)}
              {settings.stageCatalog.effectiveFromText !== ''
                ? ` · ${settings.stageCatalog.effectiveFromText} 生效`
                : ''}
            </Chip>
          ) : (
            <Chip tone="gray">无阶段目录</Chip>
          )}
        </div>
      </div>

      <div className="rcw-grid">
        <div className="rcw-main">
          <Card className="rcw-detailmain" testid="settings-write-card">
            <h2>设置写入口</h2>
            <p className="rcw-muted rcw-tiny" style={{ marginTop: 6 }}>
              设置数据只读展示；保存动作的可用性以服务端 `/overview` 的 `actions.recruiting_settings_write` 为准。
            </p>
            <div className="rcw-inlineactions">
              {writeAction !== undefined ? (
                <ActionButton
                  action={writeAction}
                  pending={pendingActionKey === writeAction.key}
                  aliasBlocked={aliasBlocked}
                  aliasNote={aliasNote}
                  onRun={onRunAction}
                />
              ) : (
                <span className="rcw-pending">服务端没有返回 recruiting_settings_write 动作</span>
              )}
            </div>
          </Card>

          <Card className="rcw-detailmain" style={{ marginTop: 14 }} testid="settings-stage-catalog">
            <div className="rcw-sectionhead" style={{ marginTop: 0 }}>
              <h2>阶段目录（stage catalog）</h2>
              <span className="rcw-dim rcw-tiny">
                {settings.stageCatalog !== null ? `${String(settings.stageCatalog.stages.length)} 个阶段` : '未提供'}
              </span>
            </div>
            {settings.stageCatalog === null || settings.stageCatalog.stages.length === 0 ? (
              <EmptyState>服务端没有返回阶段目录。</EmptyState>
            ) : (
              <div className="rcw-tablewrap">
                <table className="rcw-table">
                  <thead>
                    <tr>
                      <th>阶段码</th>
                      <th>名称</th>
                      <th>类型</th>
                      <th>顺序</th>
                      <th>v1 范围</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.stageCatalog.stages.map((stage) => (
                      <tr key={stage.code} data-testid={`stage-row-${stage.code}`}>
                        <td className="rcw-mono">{stage.code}</td>
                        <td>{stage.label}</td>
                        <td>{stage.kind !== '' ? stage.kind : '—'}</td>
                        <td>{stage.order}</td>
                        <td>{stage.inV1Scope ? '是' : '否'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="rcw-detailmain" style={{ marginTop: 14 }} testid="settings-configs">
            <div className="rcw-sectionhead" style={{ marginTop: 0 }}>
              <h2>业务配置（business_config 当前生效版本）</h2>
            </div>
            {settings.configs.length === 0 ? (
              <EmptyState>服务端没有返回业务配置。</EmptyState>
            ) : (
              <div className="rcw-tablewrap">
                <table className="rcw-table">
                  <thead>
                    <tr>
                      <th>config_key</th>
                      <th>作用域</th>
                      <th>版本</th>
                      <th>生效时间</th>
                      <th>payload 字段</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.configs.map((config) => (
                      <tr key={`${config.configKey}-${config.scope}-${config.scopeId}`}>
                        <td className="rcw-mono">{config.configKey}</td>
                        <td>{config.scope}</td>
                        <td>v{config.versionNo}</td>
                        <td>{config.effectiveFromText !== '' ? config.effectiveFromText : '—'}</td>
                        <td>{config.payloadKeys.length > 0 ? config.payloadKeys.join('、') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="rcw-detailmain" style={{ marginTop: 14 }} testid="settings-teams">
            <div className="rcw-sectionhead" style={{ marginTop: 0 }}>
              <h2>部门与招聘团队</h2>
            </div>
            <div className="rcw-subhead">
              <h3>部门</h3>
            </div>
            {settings.departments.length === 0 ? (
              <EmptyState>服务端没有返回部门。</EmptyState>
            ) : (
              <div className="rcw-chiprow">
                {settings.departments.map((department) => (
                  <Chip key={department.id !== '' ? department.id : department.name} tone="gray">
                    {department.name !== '' ? department.name : department.id}
                  </Chip>
                ))}
              </div>
            )}
            <div className="rcw-subhead">
              <h3>招聘团队</h3>
            </div>
            {settings.hiringTeams.length === 0 ? (
              <EmptyState>服务端没有返回招聘团队。</EmptyState>
            ) : (
              settings.hiringTeams.map((team) => (
                <div className="rcw-smallcard" style={{ marginTop: 10 }} key={team.id !== '' ? team.id : team.code}>
                  <strong>
                    {team.name !== '' ? team.name : team.code}
                    {team.code !== '' ? ` · ${team.code}` : ''}
                  </strong>
                  <p>{team.departmentName !== '' ? team.departmentName : '（未提供部门）'}</p>
                  {team.members.length === 0 ? (
                    <p className="rcw-dim rcw-tiny">该团队没有成员。</p>
                  ) : (
                    <div style={{ marginTop: 8 }}>
                      {team.members.map((member) => (
                        <div className="rcw-fieldrow" key={member.actorId !== '' ? member.actorId : member.displayName}>
                          <span className="rcw-fieldkey">
                            {member.displayName}
                            {member.teamRole !== '' ? ` · ${member.teamRole}` : ''}
                          </span>
                          <span className="rcw-fieldval rcw-mono">{member.actorId !== '' ? member.actorId : '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </Card>
        </div>

        <aside className="rcw-aside">
          <Card className="rcw-asidecard" testid="settings-aside-labels">
            <h2>数据来源</h2>
            <ThreeDimBadges labels={overview.labels} testid="settings-labels" />
            <div style={{ marginTop: 8 }}>
              <KeyValue label="评估时间" value={overview.evaluatedAtText} />
              <KeyValue label="契约版本" value={overview.contractVersion} />
              <KeyValue label="读取身份" value={overview.actor.displayName} />
            </div>
          </Card>
          <Card className="rcw-asidecard">
            <h2>只读说明</h2>
            <p className="rcw-muted rcw-tiny">
              本页只展示服务端返回的当前生效配置。保存动作必须走服务端 action seam；不可用时按钮禁用并显示 pending
              原因，不会写 localStorage、不会用 Toast 假装成功。
            </p>
          </Card>
        </aside>
      </div>
    </>
  )
}

/**
 * 招聘工作区（W2）。
 *
 * 不读 localStorage；`sessionId`/`alias` 只来自 props。sessionId 仅作为 DOM 证据属性带出，
 * 不进入任何请求（身份由宿主插件配置决定）。
 * @param props - `{ sessionId, alias }`。
 * @returns 工作区 JSX。
 */
export function RecruitingWorkspace(props: WorkspaceProps) {
  const overview = useWorkspaceOverview()
  const [selectedJobId, setSelectedJobId] = useState('')
  const [selectedApplicationId, setSelectedApplicationId] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [jobDetailOpen, setJobDetailOpen] = useState(false)
  const [filter, setFilter] = useState<ApplicationFilter>('all')
  const [pendingActionKey, setPendingActionKey] = useState('')
  const [feedback, setFeedback] = useState<ActionFeedback | undefined>(undefined)

  // 默认选中 = 服务端排序后的第一个岗位（OPEN 且申请最多；见 view-model.sortJobViews）。
  // 选中的岗位在 reload 后消失时回退到新的默认岗位，避免出现"行全被过滤掉"的空页。
  const jobs = overview.data?.jobs ?? []
  const fallbackJob = jobs.find((job) => job.id !== '') ?? jobs[0]
  const selectedJobStillExists = selectedJobId !== '' && jobs.some((job) => job.id === selectedJobId)
  const effectiveJobId = selectedJobStillExists ? selectedJobId : (fallbackJob?.id ?? '')
  const selectedJob = jobs.find((job) => job.id === effectiveJobId) ?? fallbackJob
  const applicationDetail = useApplicationDetail(selectedApplicationId)
  const jobDetail = useJobDetail(jobDetailOpen ? effectiveJobId : '')

  const isRecruiter = props.alias === 'recruiter'
  const aliasNote =
    '当前 alias 为面试官视图，请切换到招聘方身份（Recruiter）；本视图只做只读浏览，写操作不可用。'
  const aliasBlocked = !isRecruiter

  const overviewActions = overview.data?.actions ?? {}
  const detailActions =
    applicationDetail.data !== undefined && Object.keys(applicationDetail.data.actions).length > 0
      ? applicationDetail.data.actions
      : overviewActions

  const runAction = async (action: ActionView): Promise<void> => {
    setPendingActionKey(action.key)
    setFeedback(undefined)
    const result = await postActionSeam(action)
    if (!result.accepted) {
      setFeedback({
        tone: 'error',
        title: `写动作「${action.label}」未被服务端受理`,
        message: result.error !== null ? result.error.message : `HTTP ${String(result.status)}`,
        rawBody: result.error?.rawBody !== undefined && result.error.rawBody !== '' ? result.error.rawBody : result.bodyText,
      })
      setPendingActionKey('')
      return
    }
    setFeedback({
      tone: 'ok',
      title: `服务端已受理「${action.label}」（HTTP ${String(result.status)}）`,
      message: '正在重新 GET 服务端数据（reload）；界面只显示重新读取后的服务端事实，不会用本地状态当成功。',
      rawBody: result.bodyText,
    })
    overview.reload()
    if (selectedApplicationId !== '') applicationDetail.reload()
    if (jobDetailOpen) jobDetail.reload()
    setPendingActionKey('')
  }

  const openApplication = (applicationId: string): void => {
    setSelectedApplicationId(applicationId)
    setFeedback(undefined)
  }
  const backToOverview = (): void => {
    setSelectedApplicationId('')
    setFeedback(undefined)
  }
  const openJobFromDetail = (): void => {
    const jobId = applicationDetail.data?.header.jobId ?? ''
    if (jobId !== '') setSelectedJobId(jobId)
    setSelectedApplicationId('')
    setJobDetailOpen(true)
  }

  const overviewData = overview.data
  const rows = overviewData?.applications ?? []
  const rowsForJob = rows.filter((row) => effectiveJobId === '' || row.jobId === effectiveJobId)
  const rowsForFilter = rowsForJob.filter((row) => filter === 'all' || row.filterKind === filter)
  const filterCounts = {
    all: rowsForJob.length,
    screening: rowsForJob.filter((row) => row.filterKind === 'screening').length,
    interviewing: rowsForJob.filter((row) => row.filterKind === 'interviewing').length,
    other: rowsForJob.filter((row) => row.filterKind === 'other').length,
  }
  const siblingRows = rows.filter(
    (row) => row.id !== selectedApplicationId && row.candidateId !== '' && row.candidateId === applicationDetail.data?.header.candidateId,
  )

  return (
    <div
      className="rcw-root"
      data-testid="recruiting-workspace"
      data-view="recruiting"
      data-alias={props.alias}
      data-session-id={props.sessionId !== '' ? props.sessionId : undefined}
      style={ROOT_STYLE}
    >
      <style key={STYLE_ELEMENT_KEY}>{RECRUITING_CSS}</style>
      <div className="rcw-content">
        {aliasBlocked ? (
          <div className="rcw-notice" data-testid="alias-notice" role="status">
            {aliasNote}
          </div>
        ) : null}

        {selectedApplicationId === '' && settingsOpen ? (
          overviewData !== undefined ? (
            <SettingsPanel
              overview={overviewData}
              onBack={() => setSettingsOpen(false)}
              pendingActionKey={pendingActionKey}
              onRunAction={(action) => void runAction(action)}
              aliasBlocked={aliasBlocked}
              aliasNote={aliasNote}
            />
          ) : (
            <Card className="rcw-detailmain">
              <EmptyState>招聘设置需要先成功读取工作区投影（overview）。</EmptyState>
            </Card>
          )
        ) : selectedApplicationId !== '' ? (
          <ApplicationDetail
            row={rows.find((row) => row.id === selectedApplicationId)}
            detail={applicationDetail.data}
            loading={applicationDetail.loading}
            error={applicationDetail.error}
            onRetry={applicationDetail.reload}
            onRefresh={applicationDetail.reload}
            refreshing={applicationDetail.loading}
            onBack={backToOverview}
            actions={detailActions}
            pendingActionKey={pendingActionKey}
            onRunAction={(action) => void runAction(action)}
            aliasBlocked={aliasBlocked}
            aliasNote={aliasNote}
            siblings={siblingRows}
            onOpenApplication={openApplication}
            onOpenJob={openJobFromDetail}
          />
        ) : (
          <>
            <div className="rcw-headline" data-testid="overview-headline">
              <div className="rcw-headline-left">
                <span className="rcw-cap">AGENT-NATIVE RECRUITMENT</span>
                <h1>招聘总览</h1>
                <div className="rcw-sub">
                  岗位、申请、材料、初筛、面试、Transcript、面评与决策的服务端只读投影；写动作走 action seam。
                </div>
              </div>
              <div className="rcw-headline-right">
                <button
                  type="button"
                  className="rcw-btn"
                  data-testid="refresh-overview"
                  disabled={overview.loading}
                  onClick={overview.reload}
                >
                  {overview.loading ? '正在读取…' : '刷新'}
                </button>
                <button
                  type="button"
                  className="rcw-btn rcw-btn-soft"
                  data-testid="open-settings"
                  onClick={() => setSettingsOpen(true)}
                >
                  招聘设置
                </button>
                <Chip tone={isRecruiter ? 'blue' : 'amber'} testid="alias-chip">
                  当前身份 · {isRecruiter ? '招聘方 Recruiter' : props.alias === 'interviewer_a' ? '面试官 A（只读）' : '面试官 B（只读）'}
                </Chip>
              </div>
            </div>

            {overview.error !== undefined ? (
              <ErrorAlert
                title="招聘工作区读取失败"
                message={overview.error.message}
                rawBody={overview.error.rawBody}
                onRetry={overview.reload}
              />
            ) : null}

            {overview.loading && overviewData === undefined ? (
              <p className="rcw-loading" data-testid="overview-loading">
                正在读取招聘工作区（GET /recruitment/api/recruiting/overview）…
              </p>
            ) : null}

            {overviewData !== undefined && !overviewData.configured ? (
              <div className="rcw-notice" data-testid="overview-unconfigured">
                数据库未配置，读不到真实招聘数据
                {overviewData.issues.length > 0 ? `（缺少：${overviewData.issues.join('；')}）` : ''}
              </div>
            ) : null}
            {overviewData !== undefined && overviewData.configured && overviewData.issues.length > 0 ? (
              <div className="rcw-notice" data-testid="overview-issues">
                配置问题：{overviewData.issues.join('；')}
              </div>
            ) : null}

            {feedback !== undefined ? (
              <div
                className={feedback.tone === 'error' ? 'rcw-alert' : 'rcw-notice'}
                role={feedback.tone === 'error' ? 'alert' : 'status'}
                data-testid="action-feedback"
                data-tone={feedback.tone}
              >
                <strong>{feedback.title}</strong>
                <div style={{ marginTop: 6 }}>{feedback.message}</div>
                {feedback.rawBody !== '' ? <pre data-testid="action-feedback-raw">{feedback.rawBody}</pre> : null}
              </div>
            ) : null}

            {overviewData !== undefined ? (
              <div className="rcw-grid">
                <div className="rcw-main">
                  <JobHero
                    job={selectedJob}
                    jobs={overviewData.jobs}
                    overview={overviewData}
                    onSelectJob={(jobId) => {
                      setSelectedJobId(jobId)
                      setJobDetailOpen(false)
                    }}
                    onToggleJobDetail={() => setJobDetailOpen((value) => !value)}
                    jobDetailOpen={jobDetailOpen}
                    actions={overviewActions}
                    pendingActionKey={pendingActionKey}
                    onRunAction={(action) => void runAction(action)}
                    aliasBlocked={aliasBlocked}
                    aliasNote={aliasNote}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />

                  {jobDetailOpen ? (
                    <JobDetailCard
                      jobDetail={jobDetail.data}
                      loading={jobDetail.loading}
                      error={jobDetail.error}
                      onRetry={jobDetail.reload}
                      onClose={() => setJobDetailOpen(false)}
                    />
                  ) : null}

                  <SectionHead
                    title="此岗位下的候选人"
                    note={`共 ${String(rowsForJob.length)} 条申请 · 显示 ${String(rowsForFilter.length)} 条`}
                    right={<span className="rcw-dim rcw-tiny">点击行查看申请详情（结论 + 渐进展开证据）</span>}
                  />

                  <div className="rcw-filterbar" data-testid="application-filters">
                    {(
                      [
                        ['all', '全部'],
                        ['screening', '待初筛'],
                        ['interviewing', '面试中'],
                        ['other', '其他'],
                      ] as ReadonlyArray<readonly [ApplicationFilter, string]>
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`rcw-filter ${filter === value ? 'rcw-filter-active' : ''}`.trim()}
                        data-testid={`filter-${value}`}
                        data-active={filter === value ? 'true' : 'false'}
                        onClick={() => setFilter(value)}
                      >
                        {label}（{filterCounts[value]}）
                      </button>
                    ))}
                  </div>

                  <Card className="rcw-list" testid="application-list">
                    {rowsForFilter.length === 0 ? (
                      <EmptyState>
                        {rowsForJob.length === 0 ? '该岗位还没有申请。' : '当前筛选下没有申请。'}
                      </EmptyState>
                    ) : (
                      rowsForFilter.map((row) => (
                        <ApplicationRow key={row.rowKey} row={row} onOpen={openApplication} />
                      ))
                    )}
                  </Card>
                </div>

                <aside className="rcw-aside">
                  <JobSidebar jobs={overviewData.jobs} selectedJobId={effectiveJobId} onSelectJob={setSelectedJobId} />
                  <AttentionCard overview={overviewData} />
                  <CountsCard overview={overviewData} />
                  <SettingsEntryCard
                    overview={overviewData}
                    writeAction={overviewActions.recruiting_settings_write}
                    onOpenSettings={() => setSettingsOpen(true)}
                    pendingActionKey={pendingActionKey}
                    onRunAction={(action) => void runAction(action)}
                    aliasBlocked={aliasBlocked}
                    aliasNote={aliasNote}
                  />
                </aside>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

export default RecruitingWorkspace
