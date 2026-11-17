// 招聘工作区（W2）主视图：岗位侧栏 / 选择器 + 岗位头卡（业务结论 + 下一步 + 人类闸门动作）+ 申请列表 +
// 招聘设置写入口 + 岗位草案（task-57）。申请详情在 `application-detail.tsx`（点击行进入，返回总览）。
//
// 契约（`work/d5/w2b/INTERFACE.md` §2.3/§2.7、`work/d5/w2b/INTERFACE2.md` §5、
// `work/d5/joblife/CONTRACT.md` §3、`work/d5/joblife/CONTRACT-ACTIONS.md` §1-§3）：
//   · props 严格 `{ sessionId, alias }`，视图**不读 localStorage**、不从 URL 取业务参数；
//   · 每个视图挂载即 GET；写动作成功后重新 GET 服务端（`reload()`），不用本地状态伪造业务事实；
//   · 写按钮可用性只读服务端 `actions` / 路由探测；不可用 → disabled + 原因（含机器码），点击不发请求；
//   · 岗位关闭是**人类闸门**：弹窗取消 = 零请求；确认才 `postJobClose`，成功后显示信封 `terminated` 计数；
//   · 岗位草案：draft/create 路由用 GET 同路径探测（405=已注册 / 404=未接线），未接线 → disabled + 原因；
//   · `alias !== 'recruiter'` 时显示只读提示并禁用写动作（不伪造权限），只读浏览不崩、不空白。
//
// DOM 证据钩子：根 `data-testid="recruiting-workspace" data-view="recruiting"`；
// 岗位行 `job-row-<id>`；申请行 `application-row-<id>`；结论区 `next-step`；
// `rubric-approve` / `rubric-approve-pending`；`close-job` / `close-job` 弹窗 / `close-job-result` /
// `close-job-terminated`；`settings-role-form` / `settings-team-form` / `settings-pipeline-form`；
// `job-draft`（含 request/generate/pending/reasons/missing/rounds/criteria/edit/confirm/result）。

import { useEffect, useState } from 'react'
import {
  useApplicationDetail,
  useDecisionFacts,
  useJobDetail,
  useRouteProbe,
  useWorkspaceOverview,
  postActionSeam,
  postDecisionRecordFacade,
  postJobClose,
  postJobCreate,
  postJobDraft,
  postScreeningEvaluate,
  useJobCloseSeam,
  type RecruitingErrorInfo,
} from './use-recruiting.ts'
import {
  JOB_CREATE_PATH,
  JOB_DRAFT_PATH,
  buildJobCreateBody,
  buildJobDraftBody,
  buildRubricApproveBody,
  buildSettingsWriteBody,
  normalizeJobDraftResponse,
  parseJobCloseEnvelope,
  readbackLines,
  terminatedLines,
  type ActionOutcome,
  type JobDraftView,
  type JobCloseEnvelope,
} from './actions.ts'
import type {
  ActionView,
  ApplicationRowView,
  JobDetailView,
  JobView,
  NextStepView,
  RecruitingOverviewView,
  SettingsView,
} from './view-model.ts'
import { splitSidebarJobs, settingsEntryNoteText, applicationRubricTextOf } from './view-model.ts'
import { count, items, numberOrNull, record, stringList, text } from './format.ts'
import {
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
import { CloseJobDialog } from './close-job-dialog.tsx'
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

/** 读回行的标签：`label（key）`（label 与 key 相同时只显示一次）。 */
function readbackRowLabel(row: { readonly key: string; readonly label: string }): string {
  return row.label === '' || row.label === row.key ? row.key : `${row.label}（${row.key}）`
}

/** 最近一次写动作结果卡：2xx 不等于业务成功；只显示信封 `readback` 与服务端原文。 */
function OutcomeReadbackCard({
  outcome,
  title,
  testid,
}: {
  readonly outcome: ActionOutcome | undefined
  readonly title: string
  readonly testid: string
}) {
  if (outcome === undefined) return null
  const rows = outcome.envelope !== null ? readbackLines(outcome.envelope) : []
  return (
    <Card className="rcw-detailmain" style={{ marginTop: 14 }} testid={testid}>
      <div className="rcw-sectionhead" style={{ marginTop: 0 }}>
        <h2>{title}</h2>
        <Chip tone={outcome.accepted ? 'blue' : 'red'} testid={`${testid}-status`}>
          {outcome.accepted
            ? `HTTP ${String(outcome.status)} 已受理（业务事实看 readback）`
            : `失败（HTTP ${String(outcome.status)}）`}
        </Chip>
      </div>
      {rows.length > 0 ? (
        <div data-testid={`${testid}-lines`}>
          {rows.map((row) => (
            <KeyValue key={row.key} label={readbackRowLabel(row)} value={row.value} mono />
          ))}
        </div>
      ) : (
        <p className="rcw-muted rcw-tiny" data-testid={`${testid}-empty`}>
          服务端没有返回 readback（界面不把 2xx 当成功）。
        </p>
      )}
      {outcome.error !== null ? (
        <SourceBox testid={`${testid}-error`}>
          {outcome.error.message}
          {outcome.error.rawBody !== '' ? `\n\n${outcome.error.rawBody}` : ''}
        </SourceBox>
      ) : null}
      {outcome.envelope !== null ? (
        <p className="rcw-dim rcw-tiny" data-testid={`${testid}-actor`}>
          动作 {outcome.envelope.action} · alias{' '}
          {outcome.envelope.actor.alias !== '' ? outcome.envelope.actor.alias : '—'} · approval{' '}
          {outcome.envelope.approval.result !== '' ? outcome.envelope.approval.result : '—'}
        </p>
      ) : null}
    </Card>
  )
}

/** 服务端响应体 → JSON 对象（解析失败 → null；不猜业务值）。 */
function parseJsonObject(bodyText: string): Record<string, unknown> | null {
  const trimmed = bodyText.trim()
  if (trimmed === '') return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return record(parsed)
  } catch {
    return null
  }
}

/** 岗位关闭结果卡：信封 `terminated` 逐条 + `job.status/record_version/actor` + `replayed`。 */
function CloseJobResultCard({
  envelope,
  jobId,
  error,
  errorRaw,
  bodyText,
}: {
  readonly envelope: JobCloseEnvelope | undefined
  readonly jobId: string
  readonly error: string
  readonly errorRaw: string
  readonly bodyText: string
}) {
  if (envelope === undefined && error === '') return null
  return (
    <Card className="rcw-detailmain" style={{ marginTop: 14 }} testid="close-job-result">
      <div className="rcw-sectionhead" style={{ marginTop: 0 }}>
        <h2>岗位关闭结果（服务端信封 + 重新 GET）</h2>
        {envelope !== undefined ? (
          <Chip tone={envelope.replayed ? 'amber' : 'green'} testid="close-job-replayed">
            {envelope.replayed ? 'replayed（重复确认）' : '首次关闭'}
          </Chip>
        ) : (
          <Chip tone="red">没有可用信封</Chip>
        )}
      </div>
      {error !== '' ? (
        <ErrorAlert
          title="岗位关闭失败（服务端原文，界面不推断结果）"
          message={error}
          rawBody={errorRaw !== '' ? errorRaw : bodyText}
        />
      ) : null}
      {envelope !== undefined ? (
        <>
          <div className="rcw-kv">
            <KeyValue label="job.status" value={envelope.job.status} />
            <KeyValue label="record_version" value={String(envelope.job.recordVersion)} />
            <KeyValue label="status_changed_at" value={envelope.job.statusChangedAt} />
            <KeyValue label="status_changed_by_actor_id" value={envelope.job.statusChangedByActorId} mono />
            <KeyValue
              label="actor"
              value={`${envelope.actor.alias} · ${envelope.actor.displayName} · ${envelope.actor.actorId}`}
              mono
            />
            <KeyValue label="replayed" value={envelope.replayed ? 'true' : 'false'} />
            {/* job_id 必须来自信封（被关闭的那个 job）；不能用“当前选中岗位”——reload 后选中会漂移。 */}
            <KeyValue label="job_id" value={envelope.job.jobId !== '' ? envelope.job.jobId : jobId} mono />
          </div>
          <div className="rcw-subhead">
            <h3>本次终止计数（信封 terminated 逐条）</h3>
          </div>
          <ul className="rcw-roundfocus-list" data-testid="close-job-terminated">
            {terminatedLines(envelope.terminated).map((line) => (
              <li className="rcw-quote" key={line}>
                {line}
              </li>
            ))}
          </ul>
          <p className="rcw-muted rcw-tiny">
            已重新 GET overview 与岗位详情；界面没有先把本地岗位状态改成已关闭。
          </p>
        </>
      ) : null}
    </Card>
  )
}

/** 草案字段容错读取：先试 camelCase 键，再试 snake_case（A 的归一化命名以 INTERFACE2 为准）。 */
function draftTextNode(source: unknown, keys: readonly string[]): string {
  const raw = record(source)
  for (const key of keys) {
    const value = text(raw[key])
    if (value !== '') return value
  }
  return ''
}

/** 草案数组容错读取：缺失/坏类型 → `[]`。 */
function draftArrayNode(source: unknown, keys: readonly string[]): unknown[] {
  const raw = record(source)
  for (const key of keys) {
    const value = items(raw[key])
    if (value.length > 0) return value
  }
  return []
}

/** 草案展示事实（缺字段 → 空，不编造；`null` = 还没有草案）。 */
interface JobDraftFacts {
  readonly recruitingReason: string
  readonly responsibilities: readonly string[]
  readonly successProfile: readonly string[]
  readonly mustHave: readonly string[]
  readonly niceToHave: readonly string[]
  readonly rounds: ReadonlyArray<{
    readonly roundNo: number
    readonly title: string
    readonly focus: readonly string[]
    readonly questions: readonly string[]
  }>
  readonly rubricDimensions: ReadonlyArray<{
    readonly key: string
    readonly label: string
    readonly kind: string
    readonly weight: number | null
    readonly notes: string
  }>
  readonly reasons: ReadonlyArray<{ readonly path: string; readonly reason: string; readonly source: string }>
  readonly missingItems: ReadonlyArray<{ readonly key: string; readonly question: string }>
  readonly confirmation: { readonly required: boolean; readonly status: string; readonly note: string; readonly next: readonly string[] }
  readonly draftTitle: string
  readonly draftCode: string
}

/** 把 A 的 `JobDraftView` 拆成可渲染事实（两种键名都接受，缺字段不补默认文案）。 */
function jobDraftFactsOf(draft: JobDraftView | null): JobDraftFacts | null {
  if (draft === null) return null
  const raw = record(draft)
  const jobDraft = record(raw.job_draft ?? raw.jobDraft)
  const rubricDraft = record(raw.rubric_draft ?? raw.rubricDraft)
  const rounds: JobDraftFacts['rounds'][number][] = []
  for (const item of draftArrayNode(jobDraft, ['rounds'])) {
    const entry = record(item)
    rounds.push({
      roundNo: count(entry.round_no ?? entry.roundNo),
      title: text(entry.title),
      focus: stringList(entry.focus),
      questions: stringList(entry.questions),
    })
  }
  const rubricDimensions: JobDraftFacts['rubricDimensions'][number][] = []
  for (const item of draftArrayNode(rubricDraft, ['dimensions'])) {
    const entry = record(item)
    const key = text(entry.key)
    if (key === '') continue
    rubricDimensions.push({
      key,
      label: text(entry.label) !== '' ? text(entry.label) : key,
      kind: text(entry.kind),
      weight: numberOrNull(entry.weight),
      notes: text(entry.reason) !== '' ? text(entry.reason) : text(entry.notes),
    })
  }
  const reasons: JobDraftFacts['reasons'][number][] = []
  for (const item of draftArrayNode(raw, ['reasons'])) {
    const entry = record(item)
    const reasonLine = text(entry.reason)
    if (reasonLine === '') continue
    reasons.push({ path: text(entry.path), reason: reasonLine, source: text(entry.source) })
  }
  const missingItems: JobDraftFacts['missingItems'][number][] = []
  for (const item of draftArrayNode(raw, ['missing_items', 'missingItems'])) {
    const entry = record(item)
    const key = text(entry.key)
    const question = text(entry.question)
    if (key === '' && question === '') continue
    missingItems.push({ key, question })
  }
  const confirmationRaw = record(raw.confirmation)
  return {
    recruitingReason: draftTextNode(jobDraft, ['recruiting_reason', 'recruitingReason']),
    responsibilities: stringList(jobDraft.responsibilities),
    successProfile: stringList(jobDraft.success_profile ?? jobDraft.successProfile),
    mustHave: stringList(jobDraft.must_have ?? jobDraft.mustHave),
    niceToHave: stringList(jobDraft.nice_to_have ?? jobDraft.niceToHave),
    rounds,
    rubricDimensions,
    reasons,
    missingItems,
    confirmation: {
      required: confirmationRaw.required === true,
      status: text(confirmationRaw.status),
      note: text(confirmationRaw.note),
      next: stringList(confirmationRaw.next),
    },
    draftTitle: draftTextNode(jobDraft, ['title']),
    draftCode: draftTextNode(jobDraft, ['code']),
  }
}

/** 生成/人改/确认创建草案所需的入参（父组件负责 build* + post*）。 */
interface JobCreateInput {
  readonly code: string
  readonly title: string
  readonly departmentId: string
  readonly descriptionMd: string
  readonly requirementsMd: string
  readonly criteria: ReadonlyArray<Readonly<Record<string, unknown>>>
}

/** 岗位草案卡（task-57）：生成 → 展示服务端草案/理由/缺项/轮次/评分标准 → 人改 → 确认创建 → 读回。 */
function JobDraftCard({
  draftProbeReason,
  createProbeReason,
  draft,
  draftBusy,
  createBusy,
  draftError,
  draftRaw,
  createError,
  createRaw,
  createOutcome,
  departments,
  onGenerate,
  onCreate,
}: {
  readonly draftProbeReason: string
  readonly createProbeReason: string
  readonly draft: JobDraftView | null
  readonly draftBusy: boolean
  readonly createBusy: boolean
  readonly draftError: string
  readonly draftRaw: string
  readonly createError: string
  readonly createRaw: string
  readonly createOutcome: ActionOutcome | undefined
  readonly departments: SettingsView['departments']
  readonly onGenerate: (requestText: string) => void
  readonly onCreate: (input: JobCreateInput) => void
}) {
  const [requestText, setRequestText] = useState('')
  const [titleText, setTitleText] = useState('')
  const [codeText, setCodeText] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [descriptionMd, setDescriptionMd] = useState('')
  const [requirementsMd, setRequirementsMd] = useState('')
  const facts = jobDraftFactsOf(draft)

  // 草案到达后**预填**人改表单（只填空字段，不覆盖用户已输入的内容；预填值全部来自服务端草案）。
  useEffect(() => {
    const next = jobDraftFactsOf(draft)
    if (next === null) return
    setTitleText((current) => (current !== '' ? current : next.draftTitle))
    setCodeText((current) => (current !== '' ? current : next.draftCode))
    setDescriptionMd((current) => (current !== '' ? current : next.responsibilities.join('\n')))
    setRequirementsMd((current) =>
      current !== ''
        ? current
        : [...next.mustHave.map((line) => `必备：${line}`), ...next.niceToHave.map((line) => `加分：${line}`)].join('\n'),
    )
  }, [draft])

  const criteria = (facts?.rubricDimensions ?? []).map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    kind: dimension.kind,
    ...(dimension.weight !== null ? { weight: dimension.weight } : {}),
    ...(dimension.notes !== '' ? { notes: dimension.notes } : {}),
  }))
  const createBlockedReason =
    createProbeReason !== ''
      ? createProbeReason
      : facts === null
        ? '还没有草案，先点「生成草案」；确认创建暂不可用'
        : createBusy
          ? ''
          : ''
  const createDisabled = createBlockedReason !== '' || createBusy

  return (
    <Card className="rcw-detailmain" style={{ marginTop: 14 }} testid="job-draft">
      <div className="rcw-sectionhead" style={{ marginTop: 0 }}>
        <h2>岗位草案生成</h2>
        <Chip tone={draftProbeReason === '' ? 'blue' : 'amber'} testid="job-draft-route">
          {draftProbeReason === '' ? '草案生成可用' : '草案生成暂不可用'}
        </Chip>
      </div>
      <p className="rcw-muted rcw-tiny">
        先让服务端按你的招聘需求生成一份草案，你改完确认后才创建岗位。草案只读、不写库，内容全部来自服务端返回；
        本卡不编造企业事实，也不会自动批准评分标准。
      </p>
      {draftProbeReason !== '' ? (
        <p className="rcw-pending" data-testid="job-draft-pending">
          {draftProbeReason}
        </p>
      ) : null}

      <label className="rcw-modalfield" style={{ marginTop: 10 }}>
        <span>招聘需求原文（1..2000 字）</span>
        <textarea
          className="rcw-textarea"
          data-testid="job-draft-request-text"
          rows={3}
          value={requestText}
          disabled={draftProbeReason !== '' || draftBusy}
          placeholder="例如：我们要招一名后端工程师，做支付系统，最好有大厂经验"
          onChange={(event) => setRequestText(event.target.value)}
        />
      </label>
      <div className="rcw-inlineactions">
        <button
          type="button"
          className="rcw-btn rcw-btn-blue"
          data-testid="job-draft-generate"
          disabled={draftProbeReason !== '' || draftBusy}
          title={draftProbeReason !== '' ? draftProbeReason : '点击生成草案（只读，不写库）'}
          onClick={() => onGenerate(requestText)}
        >
          {draftBusy ? '生成中…' : '生成草案'}
        </button>
      </div>

      {draftError !== '' ? (
        <ErrorAlert title="岗位草案生成失败（服务端原文）" message={draftError} rawBody={draftRaw} />
      ) : null}

      {facts === null ? (
        <p className="rcw-muted rcw-tiny" data-testid="job-draft-empty">
          还没有草案：点「生成草案」后由服务端返回；当前无数据、不编造。
        </p>
      ) : (
        <>
          <div className="rcw-subhead">
            <h3>服务端草案（只展示，不编造）</h3>
          </div>
          {facts.recruitingReason !== '' ? (
            <KeyValue label="招聘原因（recruiting_reason）" value={facts.recruitingReason} />
          ) : null}
          {facts.responsibilities.length > 0 ? (
            <div data-testid="job-draft-responsibilities">
              <div className="rcw-cap">职责</div>
              {facts.responsibilities.map((line) => (
                <div className="rcw-quote" key={`responsibility-${line}`}>
                  {line}
                </div>
              ))}
            </div>
          ) : null}
          {facts.successProfile.length > 0 ? (
            <div data-testid="job-draft-success-profile">
              <div className="rcw-cap">成功画像</div>
              {facts.successProfile.map((line) => (
                <div className="rcw-quote" key={`success-${line}`}>
                  {line}
                </div>
              ))}
            </div>
          ) : null}
          {facts.mustHave.length > 0 ? (
            <div data-testid="job-draft-must-have">
              <div className="rcw-cap">必备条件</div>
              {facts.mustHave.map((line) => (
                <div className="rcw-quote" key={`must-${line}`}>
                  {line}
                </div>
              ))}
            </div>
          ) : null}
          {facts.niceToHave.length > 0 ? (
            <div data-testid="job-draft-nice-to-have">
              <div className="rcw-cap">加分项</div>
              {facts.niceToHave.map((line) => (
                <div className="rcw-quote" key={`nice-${line}`}>
                  {line}
                </div>
              ))}
            </div>
          ) : null}

          {facts.reasons.length > 0 ? (
            <div data-testid="job-draft-reasons">
              <div className="rcw-cap">生成理由（reasons）</div>
              {facts.reasons.map((entry, index) => (
                <div className="rcw-fieldrow" key={`reason-${String(index)}-${entry.path}`}>
                  <span className="rcw-fieldkey rcw-mono">{entry.path !== '' ? entry.path : '（未提供 path）'}</span>
                  <span className="rcw-fieldval">
                    {entry.reason}
                    {entry.source !== '' ? ` · 来源 ${entry.source}` : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {facts.missingItems.length > 0 ? (
            <div data-testid="job-draft-missing">
              <div className="rcw-cap">待补充项（需要你补充的企业事实）</div>
              {facts.missingItems.map((entry, index) => (
                <div className="rcw-fieldrow" key={`missing-${String(index)}-${entry.key}`}>
                  <span className="rcw-fieldkey rcw-mono">{entry.key !== '' ? entry.key : '（未提供 key）'}</span>
                  <span className="rcw-fieldval">{entry.question !== '' ? entry.question : '（服务端未提供追问）'}</span>
                </div>
              ))}
            </div>
          ) : null}

          {facts.rounds.length > 0 ? (
            <div data-testid="job-draft-rounds">
              <div className="rcw-cap">轮次与每轮重点</div>
              {facts.rounds.map((round, index) => (
                <div className="rcw-smallcard" style={{ marginTop: 8 }} key={`round-${String(round.roundNo)}-${String(index)}`}>
                  <strong>
                    第 {round.roundNo} 轮{round.title !== '' ? ` · ${round.title}` : ''}
                  </strong>
                  {round.focus.length > 0 ? <p>重点：{round.focus.join('、')}</p> : null}
                  {round.questions.length > 0 ? <p>问题：{round.questions.join(' / ')}</p> : null}
                </div>
              ))}
            </div>
          ) : null}

          {facts.rubricDimensions.length > 0 ? (
            <div data-testid="job-draft-criteria">
              <div className="rcw-cap">评分标准（未保存的草稿维度）</div>
              <div className="rcw-tablewrap">
                <table className="rcw-table">
                  <thead>
                    <tr>
                      <th>key</th>
                      <th>维度</th>
                      <th>kind</th>
                      <th>权重</th>
                      <th>理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {facts.rubricDimensions.map((dimension) => (
                      <tr key={dimension.key}>
                        <td className="rcw-mono">{dimension.key}</td>
                        <td>{dimension.label}</td>
                        <td>{dimension.kind !== '' ? dimension.kind : '—'}</td>
                        <td>{dimension.weight !== null ? String(dimension.weight) : '—'}</td>
                        <td>{dimension.notes !== '' ? dimension.notes : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {facts.confirmation.status !== '' || facts.confirmation.note !== '' ? (
            <p className="rcw-muted rcw-tiny" data-testid="job-draft-confirmation">
              确认闸门：{facts.confirmation.required ? '需要人工确认' : '无需确认'} ·{' '}
              {facts.confirmation.status !== '' ? facts.confirmation.status : '状态未提供'}
              {facts.confirmation.note !== '' ? ` · ${facts.confirmation.note}` : ''}
              {facts.confirmation.next.length > 0 ? ` · 下一步 ${facts.confirmation.next.join('、')}` : ''}
            </p>
          ) : null}

          <div className="rcw-subhead">
            <h3>人改后确认创建（job/create）</h3>
          </div>
          <div className="rcw-fields-grid">
            <label className="rcw-modalfield">
              <span>岗位名称</span>
              <input
                className="rcw-input"
                data-testid="job-draft-title"
                value={titleText}
                disabled={createDisabled}
                onChange={(event) => setTitleText(event.target.value)}
              />
            </label>
            <label className="rcw-modalfield">
              <span>岗位编码（2..41 大写）</span>
              <input
                className="rcw-input"
                data-testid="job-draft-code"
                value={codeText}
                disabled={createDisabled}
                onChange={(event) => setCodeText(event.target.value)}
              />
            </label>
            <label className="rcw-modalfield">
              <span>部门</span>
              <select
                className="rcw-select"
                data-testid="job-draft-department"
                value={departmentId}
                disabled={createDisabled}
                onChange={(event) => setDepartmentId(event.target.value)}
              >
                <option value="">（请选择部门 —— 服务端 settings.departments）</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name !== '' ? department.name : department.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="rcw-modalfield">
            <span>岗位描述（markdown）</span>
            <textarea
              className="rcw-textarea"
              data-testid="job-draft-description"
              rows={3}
              value={descriptionMd}
              disabled={createDisabled}
              onChange={(event) => setDescriptionMd(event.target.value)}
            />
          </label>
          <label className="rcw-modalfield">
            <span>岗位要求（markdown）</span>
            <textarea
              className="rcw-textarea"
              data-testid="job-draft-requirements"
              rows={3}
              value={requirementsMd}
              disabled={createDisabled}
              onChange={(event) => setRequirementsMd(event.target.value)}
            />
          </label>
          {createBlockedReason !== '' ? (
            <p className="rcw-pending" data-testid="job-draft-create-pending">
              {createBlockedReason}
            </p>
          ) : null}
          <div className="rcw-inlineactions">
            <button
              type="button"
              className="rcw-btn rcw-btn-blue"
              data-testid="job-draft-confirm"
              disabled={createDisabled}
              onClick={() =>
                onCreate({
                  code: codeText.trim(),
                  title: titleText.trim(),
                  departmentId,
                  descriptionMd,
                  requirementsMd,
                  criteria,
                })
              }
            >
              {createBusy ? '创建中…' : '确认创建岗位'}
            </button>
            <span className="rcw-dim rcw-tiny">
              创建后 rubric 仍为待批准（不自动 approve）；成功事实看下方 readback + 重新 GET。
            </span>
          </div>
          {createError !== '' ? (
            <ErrorAlert title="岗位创建失败（服务端原文）" message={createError} rawBody={createRaw} />
          ) : null}
          {createOutcome !== undefined ? <DraftCreateResult outcome={createOutcome} /> : null}
        </>
      )}
    </Card>
  )
}

/** 岗位创建响应卡（`job` / `versions` / `readback` 键值行；2xx 不独立当成功，靠 readback）。 */
function DraftCreateResult({ outcome }: { readonly outcome: ActionOutcome }) {
  const parsed = parseJsonObject(outcome.bodyText)
  const job = record(parsed?.job)
  const versions = record(parsed?.versions)
  const readback = record(parsed?.readback)
  const rows: { key: string; label: string; value: string }[] = []
  for (const pair of [
    ['job.job_id', job.job_id],
    ['job.code', job.code],
    ['job.status', job.status],
    ['job.record_version', job.record_version],
    ['versions.job_version_id', versions.job_version_id],
    ['versions.version_no', versions.version_no],
    ['versions.rubric_version_id', versions.rubric_version_id],
    ['versions.approval_status', versions.approval_status],
    ['readback.table', readback.table],
    ['replayed', parsed?.replayed],
  ] as ReadonlyArray<readonly [string, unknown]>) {
    const value = typeof pair[1] === 'number' ? String(pair[1]) : text(pair[1])
    if (value !== '') rows.push({ key: pair[0], label: pair[0], value })
  }
  return (
    <div className="rcw-insight" style={{ marginTop: 12 }} data-testid="job-draft-result">
      <h3>岗位创建结果（服务端响应）</h3>
      <div className="rcw-chiprow" style={{ marginTop: 6 }}>
        <Chip tone={outcome.accepted ? 'blue' : 'red'}>
          {outcome.accepted ? `HTTP ${String(outcome.status)} 已受理` : `失败（HTTP ${String(outcome.status)}）`}
        </Chip>
      </div>
      {rows.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          {rows.map((row) => (
            <KeyValue key={row.key} label={row.label} value={row.value} mono />
          ))}
        </div>
      ) : (
        <p className="rcw-muted rcw-tiny">服务端没有返回可解析的创建结果（原文见下）。</p>
      )}
      {rows.length === 0 || !outcome.accepted ? <SourceBox testid="job-draft-result-raw">{outcome.bodyText}</SourceBox> : null}
      {outcome.error !== null ? <SourceBox testid="job-draft-result-error">{outcome.error.message}</SourceBox> : null}
    </div>
  )
}

/** 申请列表行。 */
function ApplicationRow({
  row,
  jobRubric,
  onOpen,
}: {
  readonly row: ApplicationRowView
  readonly jobRubric: JobView['rubric'] | null | undefined
  readonly onOpen: (applicationId: string) => void
}) {
  // O13：把"本申请钉住的评分标准"与"岗位当前的评分标准"分成两个标签，并标出一致性。
  const pinnedRubric = row.applicationRubric
  const rubricConsistency =
    pinnedRubric !== null && jobRubric !== null && jobRubric !== undefined
      ? pinnedRubric.versionNo === jobRubric.versionNo && pinnedRubric.approved === jobRubric.approved
        ? '（与岗位当前一致）'
        : `（与岗位当前 v${String(jobRubric.versionNo)} 不一致）`
      : ''
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
          <span data-testid={`application-row-${row.id}-rubric`}>
            本申请钉住岗位标准 · {applicationRubricTextOf(row.applicationRubric)}
            {rubricConsistency}
          </span>
        </span>
      </span>
      <span className="rcw-rowend">
        <Chip tone={row.nextStep.tone} testid={`application-row-${row.id}-next-step`}>
          {/* O6：label 为空时给人话兜底，绝不把机器码（如 PROVIDE_SCREENING_DECISION）当文案。 */}
          {row.nextStep.hasStep ? (row.nextStep.label !== '' ? row.nextStep.label : '待处理') : '无下一步'}
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
  rubricPendingText,
  rubricBusy,
  onApproveRubric,
  closePendingText,
  closeBusy,
  onOpenClose,
  onOpenSettings,
}: {
  readonly job: JobView | undefined
  readonly jobs: ReadonlyArray<JobView>
  readonly overview: RecruitingOverviewView
  readonly onSelectJob: (jobId: string) => void
  readonly onToggleJobDetail: () => void
  readonly jobDetailOpen: boolean
  /** 空串 = rubric 批准可用；非空 = disabled 原因（含机器码）。 */
  readonly rubricPendingText: string
  readonly rubricBusy: boolean
  readonly onApproveRubric: () => void
  /** 空串 = 岗位关闭可用；非空 = disabled 原因（含机器码，如 JOB_CLOSE_ROUTE_MISSING）。 */
  readonly closePendingText: string
  readonly closeBusy: boolean
  readonly onOpenClose: () => void
  readonly onOpenSettings: () => void
}) {
  if (job === undefined) {
    return (
      <Card className="rcw-hero" testid="job-hero">
        <span className="rcw-cap">当前招聘岗位</span>
        <h2 style={{ marginTop: 6 }}>没有可展示的岗位</h2>
        <p className="rcw-sub">服务端 overview 的 jobs 为空：招聘数据可能尚未接入，界面不编造岗位。</p>
        <NextStepPanel step={EMPTY_STEP} scope="job" fallback="还没有岗位" />
      </Card>
    )
  }
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
            未关联岗位标准
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
      <NextStepPanel step={job.nextStep} scope="job" fallback="暂无下一步" />

      <div className="rcw-inlineactions" data-testid="job-actions">
        <span className="rcw-actionwrap">
          <button
            type="button"
            className={`rcw-btn ${rubricPendingText === '' ? 'rcw-btn-blue' : ''}`.trim()}
            data-testid="rubric-approve"
            data-available={rubricPendingText === '' ? 'true' : 'false'}
            data-pending-reason={rubricPendingText !== '' ? rubricPendingText : undefined}
            disabled={rubricPendingText !== '' || rubricBusy}
            title={
              rubricPendingText !== ''
                ? rubricPendingText
                : '点击即由你确认批准当前岗位的评分标准（会留下审批记录）'
            }
            onClick={() => {
              if (rubricPendingText !== '') return
              onApproveRubric()
            }}
          >
            {rubricBusy ? '提交中…' : '批准岗位标准'}
          </button>
          {rubricPendingText !== '' ? (
            <span className="rcw-pending" data-testid="rubric-approve-pending">
              {rubricPendingText}
            </span>
          ) : null}
        </span>
        <span className="rcw-actionwrap">
          <button
            type="button"
            className="rcw-btn rcw-btn-negative"
            data-testid="close-job"
            data-available={closePendingText === '' ? 'true' : 'false'}
            data-pending-reason={closePendingText !== '' ? closePendingText : undefined}
            disabled={closePendingText !== '' || closeBusy}
            title={closePendingText !== '' ? closePendingText : '打开确认弹窗（取消 = 零请求）'}
            onClick={() => {
              if (closePendingText !== '') return
              onOpenClose()
            }}
          >
            关闭岗位
          </button>
          {closePendingText !== '' ? (
            <span className="rcw-pending" data-testid="close-job-pending">
              {closePendingText}
            </span>
          ) : null}
        </span>
        <button type="button" className="rcw-btn" data-testid="toggle-job-detail" onClick={onToggleJobDetail}>
          {jobDetailOpen ? '收起岗位版本与岗位标准' : '查看岗位版本与岗位标准'}
        </button>
        <button type="button" className="rcw-btn rcw-btn-soft" data-testid="open-settings" onClick={onOpenSettings}>
          招聘设置（只读）
        </button>
      </div>

      <div className="rcw-nextstep-meta" style={{ marginTop: 10 }}>
        <span>岗位创建：{job.createdAtText !== '' ? job.createdAtText : '—'}</span>
        <span>状态变更：{job.statusChangedAtText !== '' ? job.statusChangedAtText : '—'}</span>
        <span>
          {/* O6：UUID 是内部 id，HR 主文案不展示；改显示业务岗位编号（为空则不给假编号）。 */}
          <span data-job-id={job.id !== '' ? job.id : undefined}>岗位编号：</span>
          <span className="rcw-code">{job.code !== '' ? job.code : '—'}</span>
        </span>
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
        <h2>岗位详情 · 版本与岗位标准</h2>
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
                岗位当前评分标准 · r{String(jobDetail.rubric.versionNo)} · {jobDetail.rubric.dimensions.length} 个维度 ·{' '}
                {jobDetail.rubric.approved ? '已批准' : '未批准'}
              </Chip>
            ) : (
              <Chip tone="gray">未关联岗位标准</Chip>
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
            <h3>岗位标准维度</h3>
          </div>
          {jobDetail.rubric === null || jobDetail.rubric.dimensions.length === 0 ? (
            <EmptyState>该岗位没有可用的岗位标准维度。</EmptyState>
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
        label="面评份数（跨轮合计）"
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

/** 招聘设置入口卡（只读数据；写入口可用性以服务端 settings.entry + action 为准）。 */
function SettingsEntryCard({
  overview,
  writeStateText,
  onOpenSettings,
}: {
  readonly overview: RecruitingOverviewView
  readonly writeStateText: string
  readonly onOpenSettings: () => void
}) {
  const { settings } = overview
  return (
    <Card className="rcw-asidecard" testid="settings-entry">
      <h2>招聘设置</h2>
      <p className="rcw-muted rcw-tiny" data-testid="settings-entry-note" data-note={settings.entry.note !== '' ? settings.entry.note : undefined}>
        {settingsEntryNoteText(settings.entry)}
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
          打开招聘设置（create 表单）
        </button>
        <span className="rcw-pending" data-testid="settings-entry-write-state">
          {writeStateText !== '' ? writeStateText : '设置写入口可用（role / team / pipeline 最小 create 表单）'}
        </span>
      </div>
      {settings.entry.available ? (
        <p className="rcw-tiny" style={{ marginTop: 8 }} data-testid="settings-entry-available">
          设置页已可用。
        </p>
      ) : null}
    </Card>
  )
}

/** 设置视图：只读配置 + role / team / pipeline **最小 create 表单**（写操作只走服务端 action seam）。 */
function SettingsPanel({
  overview,
  onBack,
  writeDisabledReason,
  settingsBusy,
  onCreateSettings,
  actionOutcome,
  feedback,
}: {
  readonly overview: RecruitingOverviewView
  readonly onBack: () => void
  /** 空串 = 设置写入口可用；非空 = disabled 原因（含机器码）。 */
  readonly writeDisabledReason: string
  readonly settingsBusy: boolean
  readonly onCreateSettings: (entity: 'role' | 'team' | 'pipeline', fields: Readonly<Record<string, unknown>>) => void
  readonly actionOutcome: ActionOutcome | undefined
  readonly feedback: ActionFeedback | undefined
}) {
  const settings: SettingsView = overview.settings
  // 三个最小 create 表单的受控字段（只做 create；update / add_member 等不在本页，不假装覆盖）。
  const [roleCode, setRoleCode] = useState('')
  const [roleName, setRoleName] = useState('')
  const [roleScopes, setRoleScopes] = useState('')
  const [teamCode, setTeamCode] = useState('')
  const [teamName, setTeamName] = useState('')
  const [teamDepartmentId, setTeamDepartmentId] = useState('')
  const [pipelineCode, setPipelineCode] = useState('')
  const [pipelineName, setPipelineName] = useState('')
  const settingsDisabled = writeDisabledReason !== '' || settingsBusy
  const settingsAction = overview.actions.recruiting_settings_write
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
            <h2>设置写入口（新增角色 / 团队 / 流程模板）</h2>
            <p className="rcw-muted rcw-tiny" style={{ marginTop: 6 }}>
              角色填 code / name / permission_scopes；团队填 code / name / department_id；流程模板填 code / name。
              保存是否可用以服务端声明为准；不可用时按钮禁用并说明原因。本页只做新增，
              修改 / 加成员 / 加阶段等操作没有表单（不假装覆盖）。
            </p>
            {writeDisabledReason !== '' ? (
              <p className="rcw-pending" data-testid="settings-write-pending">
                {writeDisabledReason}
              </p>
            ) : (
              <p className="rcw-pending" data-testid="settings-write-pending-ok">
                设置写入口可用；保存后页面会重新读取并显示服务端读回结果。
              </p>
            )}
            {feedback !== undefined ? (
              <div
                className={feedback.tone === 'error' ? 'rcw-alert' : 'rcw-notice'}
                role={feedback.tone === 'error' ? 'alert' : 'status'}
                data-testid="settings-feedback"
                data-tone={feedback.tone}
              >
                <strong>{feedback.title}</strong>
                <div style={{ marginTop: 6 }}>{feedback.message}</div>
                {feedback.rawBody !== '' ? <pre data-testid="settings-feedback-raw">{feedback.rawBody}</pre> : null}
              </div>
            ) : null}

            <form
              className="rcw-writeform"
              data-testid="settings-role-form"
              onSubmit={(event) => {
                event.preventDefault()
                onCreateSettings('role', {
                  code: roleCode.trim(),
                  name: roleName.trim(),
                  permission_scopes: roleScopes
                    .split(/[\s,，;；]+/)
                    .map((scope) => scope.trim())
                    .filter((scope) => scope !== ''),
                })
              }}
            >
              <strong>新建角色（role create）</strong>
              <div className="rcw-fields-grid">
                <label className="rcw-modalfield">
                  <span>code（2..41 大写）</span>
                  <input
                    className="rcw-input"
                    data-testid="settings-role-code"
                    value={roleCode}
                    disabled={settingsDisabled}
                    onChange={(event) => setRoleCode(event.target.value)}
                  />
                </label>
                <label className="rcw-modalfield">
                  <span>name（1..200）</span>
                  <input
                    className="rcw-input"
                    data-testid="settings-role-name"
                    value={roleName}
                    disabled={settingsDisabled}
                    onChange={(event) => setRoleName(event.target.value)}
                  />
                </label>
              </div>
              <label className="rcw-modalfield">
                <span>permission_scopes（逗号分隔；服务端校验封闭枚举）</span>
                <input
                  className="rcw-input"
                  data-testid="settings-role-scopes"
                  value={roleScopes}
                  disabled={settingsDisabled}
                  placeholder="例如 JOB_READ,JOB_WRITE"
                  onChange={(event) => setRoleScopes(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="rcw-btn rcw-btn-blue"
                data-testid="settings-role-submit"
                disabled={settingsDisabled}
                title={writeDisabledReason !== '' ? writeDisabledReason : settingsAction?.seam}
              >
                {settingsBusy ? '提交中…' : '创建角色'}
              </button>
            </form>

            <form
              className="rcw-writeform"
              data-testid="settings-team-form"
              onSubmit={(event) => {
                event.preventDefault()
                onCreateSettings('team', {
                  code: teamCode.trim(),
                  name: teamName.trim(),
                  department_id: teamDepartmentId,
                })
              }}
            >
              <strong>新建招聘团队（team create）</strong>
              <div className="rcw-fields-grid">
                <label className="rcw-modalfield">
                  <span>code</span>
                  <input
                    className="rcw-input"
                    data-testid="settings-team-code"
                    value={teamCode}
                    disabled={settingsDisabled}
                    onChange={(event) => setTeamCode(event.target.value)}
                  />
                </label>
                <label className="rcw-modalfield">
                  <span>name</span>
                  <input
                    className="rcw-input"
                    data-testid="settings-team-name"
                    value={teamName}
                    disabled={settingsDisabled}
                    onChange={(event) => setTeamName(event.target.value)}
                  />
                </label>
              </div>
              <label className="rcw-modalfield">
                <span>department_id（来自服务端 settings.departments）</span>
                <select
                  className="rcw-select"
                  data-testid="settings-team-department"
                  value={teamDepartmentId}
                  disabled={settingsDisabled}
                  onChange={(event) => setTeamDepartmentId(event.target.value)}
                >
                  <option value="">（请选择部门）</option>
                  {settings.departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name !== '' ? department.name : department.id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rcw-btn rcw-btn-blue"
                data-testid="settings-team-submit"
                disabled={settingsDisabled}
                title={writeDisabledReason !== '' ? writeDisabledReason : settingsAction?.seam}
              >
                {settingsBusy ? '提交中…' : '创建团队'}
              </button>
            </form>

            <form
              className="rcw-writeform"
              data-testid="settings-pipeline-form"
              onSubmit={(event) => {
                event.preventDefault()
                onCreateSettings('pipeline', { code: pipelineCode.trim(), name: pipelineName.trim() })
              }}
            >
              <strong>新建招聘流程模板（pipeline create）</strong>
              <div className="rcw-fields-grid">
                <label className="rcw-modalfield">
                  <span>code</span>
                  <input
                    className="rcw-input"
                    data-testid="settings-pipeline-code"
                    value={pipelineCode}
                    disabled={settingsDisabled}
                    onChange={(event) => setPipelineCode(event.target.value)}
                  />
                </label>
                <label className="rcw-modalfield">
                  <span>name</span>
                  <input
                    className="rcw-input"
                    data-testid="settings-pipeline-name"
                    value={pipelineName}
                    disabled={settingsDisabled}
                    onChange={(event) => setPipelineName(event.target.value)}
                  />
                </label>
              </div>
              <button
                type="submit"
                className="rcw-btn rcw-btn-blue"
                data-testid="settings-pipeline-submit"
                disabled={settingsDisabled}
                title={writeDisabledReason !== '' ? writeDisabledReason : settingsAction?.seam}
              >
                {settingsBusy ? '提交中…' : '创建流程模板'}
              </button>
            </form>

            {actionOutcome !== undefined && actionOutcome.key === 'recruiting_settings_write' ? (
              <OutcomeReadbackCard
                outcome={actionOutcome}
                title="设置写入读回（信封 readback；键名/值原样）"
                testid="settings-write-readback"
              />
            ) : null}
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
              本页只展示服务端返回的当前生效配置。保存动作由服务端执行；不可用时按钮禁用并说明原因，
              不会只改本地显示、也不会用弹窗假装保存成功。
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
  // 最近一次写动作结果（成功只信信封 readback + reload；失败保留服务端原文）。
  const [actionOutcome, setActionOutcome] = useState<ActionOutcome | undefined>(undefined)
  // 岗位关闭（人类闸门）：弹窗 / 提交中 / 服务端原文 / 成功后信封。
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)
  const [closeError, setCloseError] = useState('')
  const [closeRaw, setCloseRaw] = useState('')
  const [closeEnvelope, setCloseEnvelope] = useState<JobCloseEnvelope | undefined>(undefined)
  const [closeBodyText, setCloseBodyText] = useState('')
  // 岗位草案（task-57）：生成 / 人改 / 确认创建。
  const [jobDraft, setJobDraft] = useState<JobDraftView | null>(null)
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [draftRaw, setDraftRaw] = useState('')
  const [draftCreateBusy, setDraftCreateBusy] = useState(false)
  const [draftCreateError, setDraftCreateError] = useState('')
  const [draftCreateRaw, setDraftCreateRaw] = useState('')
  const [draftOutcome, setDraftOutcome] = useState<ActionOutcome | undefined>(undefined)

  // 默认选中 = 服务端排序后的第一个岗位（OPEN 且申请最多；见 view-model.sortJobViews）。
  // 选中的岗位在 reload 后消失时回退到新的默认岗位，避免出现"行全被过滤掉"的空页。
  const jobs = overview.data?.jobs ?? []
  const fallbackJob = jobs.find((job) => job.id !== '') ?? jobs[0]
  const selectedJobStillExists = selectedJobId !== '' && jobs.some((job) => job.id === selectedJobId)
  const effectiveJobId = selectedJobStillExists ? selectedJobId : (fallbackJob?.id ?? '')
  const selectedJob = jobs.find((job) => job.id === effectiveJobId) ?? fallbackJob
  const applicationDetail = useApplicationDetail(selectedApplicationId)
  const jobDetail = useJobDetail(jobDetailOpen ? effectiveJobId : '')
  // 决策事实只读投影（A 的 `GET /recruitment/api/decision/facts`；404 → probe=MISSING，详情表单据此 disabled）。
  const decisionFacts = useDecisionFacts(selectedApplicationId, selectedApplicationId !== '', props.sessionId)

  const isRecruiter = props.alias === 'recruiter'
  // O6：不给 HR 看 `alias` 这类内部词；按"视图身份"说人话（同一份文案也用于写按钮的 disabled 原因）。
  const aliasNote = '当前是面试官视图：只读浏览；写操作请切换到「招聘方 Recruiter」身份后再进行。'
  const aliasBlocked = !isRecruiter

  // 路由能力探测：GET 同路径（405=已注册 POST 路由；404=未接线；403=同源/session 问题）。零写入、不打写日志。
  const closeSeam = useJobCloseSeam(props.sessionId, isRecruiter)
  const draftProbe = useRouteProbe(JOB_DRAFT_PATH, props.sessionId, isRecruiter)
  const createProbe = useRouteProbe(JOB_CREATE_PATH, props.sessionId, isRecruiter)

  const overviewActions = overview.data?.actions ?? {}
  const detailActions =
    applicationDetail.data !== undefined && Object.keys(applicationDetail.data.actions).length > 0
      ? applicationDetail.data.actions
      : overviewActions

  /** 岗位关闭按钮的 disabled 原因（'' = 可用）。O6：只给 HR 人话，探针状态码留在代码/结构化状态里。 */
  const closePendingText = ((): string => {
    if (!isRecruiter) return aliasNote
    if (closeSeam.loading) return '正在确认「关闭岗位」是否可用…'
    const probe = closeSeam.probe
    if (probe === undefined) return '还在确认「关闭岗位」是否可用…'
    if (probe.state === 'AVAILABLE') return ''
    if (probe.state === 'MISSING') {
      return '「关闭岗位」暂不可用：当前页面版本没有提供这个操作（不需要你再做什么）。'
    }
    if (probe.state === 'FORBIDDEN') {
      return '「关闭岗位」未获授权：当前页面不能执行该操作，请联系管理员。'
    }
    return '暂时确认不了「关闭岗位」是否可用，请稍后重试。'
  })()

  /** 岗位草案生成按钮的 disabled 原因（'' = 可用）。 */
  const draftPendingText = ((): string => {
    if (!isRecruiter) return aliasNote
    if (draftProbe.loading) return '正在确认「生成草案」是否可用…'
    if (draftProbe.state === 'AVAILABLE') return ''
    if (draftProbe.state === 'MISSING') {
      return '「生成草案」暂不可用：当前页面版本没有提供这个操作（不需要你再做什么）。'
    }
    return '暂时确认不了「生成草案」是否可用，请稍后重试。'
  })()

  /** 岗位确认创建按钮的 disabled 原因（'' = 可用）。 */
  const createPendingText = ((): string => {
    if (!isRecruiter) return aliasNote
    if (createProbe.loading) return '正在确认「确认创建岗位」是否可用…'
    if (createProbe.state === 'AVAILABLE') return ''
    if (createProbe.state === 'MISSING') {
      return '「确认创建岗位」暂不可用：当前页面版本没有提供这个操作（不需要你再做什么）。'
    }
    return '暂时确认不了「确认创建岗位」是否可用，请稍后重试。'
  })()

  /** Rubric 批准 disabled 原因（'' = 可用；版本 id 空或已批准 → disabled，不编造版本）。 */
  const rubricAction = overviewActions.rubric_approve
  const rubricJob = jobDetailOpen && jobDetail.data !== undefined ? jobDetail.data.job : selectedJob
  const rubricJobId = rubricJob?.id ?? selectedJob?.id ?? ''
  const rubricVersionId = rubricJob?.rubric?.rubricVersionId ?? ''
  const rubricApproved =
    rubricJob?.rubric?.approved === true || (jobDetailOpen && jobDetail.data?.rubric?.approved === true)
  const rubricPendingText = ((): string => {
    if (!isRecruiter) return aliasNote
    if (rubricAction === undefined) return '当前页面版本没有提供「批准岗位标准」操作。'
    if (!rubricAction.available) {
      return rubricAction.reasonText !== '' ? rubricAction.reasonText : '暂时不能批准评分标准。'
    }
    if (rubricJobId === '') return '还没有选中岗位，暂时不能批准评分标准。'
    if (rubricVersionId === '') {
      return '服务端没有返回当前评分标准的版本，无法批准（界面不会猜一个版本）。'
    }
    if (rubricApproved) return '当前评分标准已批准，无需重复批准。'
    return ''
  })()

  /** 设置写入口 disabled 原因（以服务端 settings.entry.available 与 action 可用性为准）。 */
  const settingsAction = overviewActions.recruiting_settings_write
  const settingsWriteDisabledReason = ((): string => {
    if (!isRecruiter) return aliasNote
    if (overview.data === undefined) return '招聘设置需要先成功读取工作区数据。'
    if (!overview.data.settings.entry.available) {
      return '服务端声明设置页暂不可用（当前只读）；页面不会假装保存成功。'
    }
    if (settingsAction === undefined) return '当前页面版本没有提供「保存设置」操作。'
    if (!settingsAction.available) {
      return settingsAction.reasonText !== '' ? settingsAction.reasonText : '暂时不能保存设置。'
    }
    return ''
  })()

  /** 写动作统一入口：仅在表单 build* 通过后才调用；成功只设 outcome + reload，不用本地状态当成功。 */
  const runAction = async (action: ActionView, request: Readonly<Record<string, unknown>>): Promise<void> => {
    setPendingActionKey(action.key)
    setFeedback(undefined)
    const outcome = await postActionSeam(action, request, props.sessionId)
    setActionOutcome(outcome)
    if (!outcome.accepted) {
      setFeedback({
        tone: 'error',
        title: `写动作「${action.label}」未被服务端受理（HTTP ${String(outcome.status)}）`,
        message: outcome.error !== null ? outcome.error.message : '服务端没有返回错误详情',
        rawBody:
          outcome.error !== null && outcome.error.rawBody !== '' ? outcome.error.rawBody : outcome.bodyText,
      })
      setPendingActionKey('')
      return
    }
    setFeedback({
      tone: 'ok',
      title: `服务端已受理「${action.label}」（HTTP ${String(outcome.status)}）`,
      message: '成功事实只信响应信封 readback + 重新 GET 的服务端投影；界面不用本地状态当成功。',
      rawBody: '',
    })
    overview.reload()
    applicationDetail.reload()
    jobDetail.reload()
    setPendingActionKey('')
  }

  /** Rubric 批准：body 由 `buildRubricApproveBody` 产出（预检失败不发请求）。 */
  const approveRubric = (): void => {
    if (rubricAction === undefined) return
    const built = buildRubricApproveBody({ jobId: rubricJobId, rubricVersionId })
    if (!built.ok) {
      setFeedback({
        tone: 'error',
        title: '岗位标准批准未发送：表单预检未通过',
        message: `${built.reasonCode}：${built.reasonText}${built.missing.length > 0 ? `；缺少：${built.missing.join('、')}` : ''}`,
        rawBody: '',
      })
      return
    }
    void runAction(rubricAction, built.body)
  }

  /** 打开岗位关闭弹窗（零请求；真正 POST 只在 onConfirm 后）。 */
  const openCloseDialog = (): void => {
    setCloseError('')
    setCloseRaw('')
    setCloseDialogOpen(true)
  }

  /** 取消关闭：只关弹窗，**零请求**、零写入。 */
  const cancelCloseDialog = (): void => {
    setCloseDialogOpen(false)
    setCloseError('')
    setCloseRaw('')
    setCloseBusy(false)
  }

  /** 人类确认关闭 → POST job/close → 显示信封 terminated 计数 + 重新 GET（不先改本地状态）。 */
  const confirmCloseJob = async (reason: string): Promise<void> => {
    const jobId = selectedJob?.id ?? ''
    if (jobId === '') {
      setCloseError('还没有选中岗位，未发送关闭请求')
      return
    }
    setCloseBusy(true)
    setCloseError('')
    setCloseRaw('')
    setCloseEnvelope(undefined)
    setCloseBodyText('')
    const outcome = await postJobClose(jobId, reason, props.sessionId)
    setCloseBusy(false)
    if (!outcome.accepted) {
      setCloseError(
        outcome.error !== null ? outcome.error.message : `服务端返回 HTTP ${String(outcome.status)}（没有错误详情）`,
      )
      setCloseRaw(outcome.error !== null && outcome.error.rawBody !== '' ? outcome.error.rawBody : outcome.bodyText)
      return
    }
    const envelope = parseJobCloseEnvelope(outcome.bodyText)
    setCloseBodyText(outcome.bodyText)
    setCloseEnvelope(envelope === null ? undefined : envelope)
    setCloseDialogOpen(false)
    if (envelope === null) {
      setCloseError('服务端返回 2xx，但响应不是 job/close 信封（见原文）；界面不推断关闭结果。')
    }
    overview.reload()
    jobDetail.reload()
    setFeedback({
      tone: 'ok',
      title: '岗位关闭已被服务端受理（请读信封 terminated 计数）',
      message: '已重新 GET overview 与岗位详情；本地没有先把岗位状态改成已关闭。',
      rawBody: '',
    })
  }

  /** 设置 create（role/team/pipeline）：封闭字段由 `buildSettingsWriteBody` 校验，预检失败不发请求。 */
  const runSettingsCreate = (
    entity: 'role' | 'team' | 'pipeline',
    fields: Readonly<Record<string, unknown>>,
  ): void => {
    if (settingsAction === undefined) {
      setFeedback({
        tone: 'error',
        title: '设置写入未发送',
        message: '当前页面版本没有提供「保存招聘设置」操作',
        rawBody: '',
      })
      return
    }
    const built = buildSettingsWriteBody({ entity, operation: 'create', fields })
    if (!built.ok) {
      setFeedback({
        tone: 'error',
        title: `设置 create（${entity}）未发送：表单预检未通过`,
        message: `${built.reasonCode}：${built.reasonText}${built.missing.length > 0 ? `；缺少：${built.missing.join('、')}` : ''}`,
        rawBody: '',
      })
      return
    }
    void runAction(settingsAction, built.body)
  }

  /** 生成岗位草案（POST job/draft，只读）：成功渲染服务端草案；不编造内容。 */
  const generateJobDraft = async (requestText: string): Promise<void> => {
    setDraftBusy(true)
    setDraftError('')
    setDraftRaw('')
    setDraftOutcome(undefined)
    setDraftCreateError('')
    setDraftCreateRaw('')
    setJobDraft(null)
    const built = buildJobDraftBody({ requestText })
    if (!built.ok) {
      setDraftError(`${built.reasonCode}：${built.reasonText}`)
      setDraftBusy(false)
      return
    }
    const outcome = await postJobDraft(built.body, props.sessionId)
    setDraftBusy(false)
    if (!outcome.accepted) {
      setDraftError(outcome.error !== null ? outcome.error.message : `HTTP ${String(outcome.status)}`)
      setDraftRaw(outcome.error !== null && outcome.error.rawBody !== '' ? outcome.error.rawBody : outcome.bodyText)
      return
    }
    const parsed = parseJsonObject(outcome.bodyText)
    const view = parsed === null ? null : normalizeJobDraftResponse(parsed)
    if (view === null) {
      setDraftError('服务端返回 2xx，但草案响应无法归一化（见原文）；不编造草案内容。')
      setDraftRaw(outcome.bodyText)
      return
    }
    setJobDraft(view)
  }

  /** 人改后确认创建（POST job/create）：criteria 来自草案 rubric 维度；服务端校验失败原样展示。 */
  const createJobFromDraft = async (input: JobCreateInput): Promise<void> => {
    setDraftCreateBusy(true)
    setDraftCreateError('')
    setDraftCreateRaw('')
    setDraftOutcome(undefined)
    const built = buildJobCreateBody(input)
    if (!built.ok) {
      setDraftCreateError(
        `${built.reasonCode}：${built.reasonText}${built.missing.length > 0 ? `；缺少：${built.missing.join('、')}` : ''}`,
      )
      setDraftCreateBusy(false)
      return
    }
    const outcome = await postJobCreate(built.body, props.sessionId)
    setDraftOutcome(outcome)
    setDraftCreateBusy(false)
    if (!outcome.accepted) {
      setDraftCreateError(outcome.error !== null ? outcome.error.message : `HTTP ${String(outcome.status)}`)
      setDraftCreateRaw(outcome.error !== null && outcome.error.rawBody !== '' ? outcome.error.rawBody : outcome.bodyText)
      return
    }
    overview.reload()
  }

  /** 执行初筛评估（A 的 `POST /decision/screening/evaluate`）：成功 reload facts + overview + 详情。 */
  const runScreeningEvaluate = async (): Promise<void> => {
    const applicationId = selectedApplicationId
    if (applicationId === '') return
    setFeedback(undefined)
    const outcome = await postScreeningEvaluate(applicationId, props.sessionId)
    setActionOutcome(outcome)
    if (!outcome.accepted) {
      setFeedback({
        tone: 'error',
        title: `执行初筛评估未被服务端受理（HTTP ${String(outcome.status)}）`,
        message: outcome.error !== null ? outcome.error.message : '服务端没有返回错误详情',
        rawBody: outcome.error !== null && outcome.error.rawBody !== '' ? outcome.error.rawBody : outcome.bodyText,
      })
    } else {
      setFeedback({
        tone: 'ok',
        title: `初筛评估已受理（HTTP ${String(outcome.status)}）`,
        message: '已重新 GET decision facts / overview / 申请详情；成功事实以 readback + 重新 GET 为准。',
        rawBody: '',
      })
    }
    decisionFacts.reload()
    overview.reload()
    applicationDetail.reload()
  }

  /** 记录正式决策（A 的 facade：body 由详情页 `buildDecisionRecordBody` 产出，不由 UI 发明 hash）。 */
  const runDecisionRecord = async (request: Readonly<Record<string, unknown>>): Promise<void> => {
    setFeedback(undefined)
    const outcome = await postDecisionRecordFacade(request, props.sessionId)
    setActionOutcome(outcome)
    if (!outcome.accepted) {
      setFeedback({
        tone: 'error',
        title: `记录决策未被服务端受理（HTTP ${String(outcome.status)}）`,
        message: outcome.error !== null ? outcome.error.message : '服务端没有返回错误详情',
        rawBody: outcome.error !== null && outcome.error.rawBody !== '' ? outcome.error.rawBody : outcome.bodyText,
      })
    } else {
      setFeedback({
        tone: 'ok',
        title: `决策记录已受理（HTTP ${String(outcome.status)}）`,
        message: '已重新 GET decision facts / overview / 申请详情；成功事实以 readback + 重新 GET 为准。',
        rawBody: '',
      })
    }
    decisionFacts.reload()
    overview.reload()
    applicationDetail.reload()
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
              writeDisabledReason={settingsWriteDisabledReason}
              settingsBusy={pendingActionKey === 'recruiting_settings_write'}
              onCreateSettings={runSettingsCreate}
              actionOutcome={actionOutcome}
              feedback={feedback}
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
            onRunAction={runAction}
            aliasBlocked={aliasBlocked}
            aliasNote={aliasNote}
            settings={overviewData?.settings}
            actionOutcome={actionOutcome}
            decisionFacts={decisionFacts.facts}
            decisionFactsProbe={decisionFacts.probe}
            onScreeningEvaluate={() => void runScreeningEvaluate()}
            onDecisionRecord={(request) => void runDecisionRecord(request)}
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
                  招聘全流程的只读视图；写操作会先让你确认再执行。
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
                正在读取招聘工作区…
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
                    rubricPendingText={rubricPendingText}
                    rubricBusy={pendingActionKey === 'rubric_approve'}
                    onApproveRubric={approveRubric}
                    closePendingText={closePendingText}
                    closeBusy={closeBusy}
                    onOpenClose={openCloseDialog}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />

                  {actionOutcome !== undefined && actionOutcome.key === 'rubric_approve' ? (
                    <OutcomeReadbackCard
                      outcome={actionOutcome}
                      title="岗位标准批准读回（信封 readback：approval / rubric / job）"
                      testid="rubric-approve-readback"
                    />
                  ) : null}

                  <CloseJobResultCard
                    envelope={closeEnvelope}
                    jobId={selectedJob?.id ?? ''}
                    error={closeError}
                    errorRaw={closeRaw}
                    bodyText={closeBodyText}
                  />

                  <JobDraftCard
                    draftProbeReason={draftPendingText}
                    createProbeReason={createPendingText}
                    draft={jobDraft}
                    draftBusy={draftBusy}
                    createBusy={draftCreateBusy}
                    draftError={draftError}
                    draftRaw={draftRaw}
                    createError={draftCreateError}
                    createRaw={draftCreateRaw}
                    createOutcome={draftOutcome}
                    departments={overviewData.settings.departments}
                    onGenerate={(requestText) => void generateJobDraft(requestText)}
                    onCreate={(input) => void createJobFromDraft(input)}
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
                    right={<span className="rcw-dim rcw-tiny">点击行查看申请详情（结论 + 逐条展开的对应情况与原文出处）</span>}
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
                        <ApplicationRow
                          key={row.rowKey}
                          row={row}
                          jobRubric={selectedJob?.rubric ?? null}
                          onOpen={openApplication}
                        />
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
                    writeStateText={settingsWriteDisabledReason}
                    onOpenSettings={() => setSettingsOpen(true)}
                  />
                </aside>
              </div>
            ) : null}
          </>
        )}
      </div>
      {/* 人类闸门：岗位关闭弹窗（取消 = 零请求；确认才 POST job/close） */}
      {closeDialogOpen ? (
        <CloseJobDialog
          jobTitle={selectedJob?.title ?? ''}
          busy={closeBusy}
          error={closeError !== '' && closeRaw !== '' ? `${closeError}\n\n服务端原文：\n${closeRaw}` : closeError}
          onConfirm={(reason) => void confirmCloseJob(reason)}
          onCancel={cancelCloseDialog}
        />
      ) : null}
    </div>
  )
}

export default RecruitingWorkspace
