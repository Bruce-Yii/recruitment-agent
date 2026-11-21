// 面板渲染层：把 `useOverview()` 的数据按 **actor 视角**渲染成只读工作台，
// 并在其中嵌入 D-89 的动态面评表单（按 rubric dimension 逐字段渲染控件）。
//
// 三条硬约束（验收口径）：
//   1. 空列表显示「没有…」——不显示 `0 条 undefined` 这类东西；
//   2. 任何缺失字段都在数据层被收紧成 '' / 0 / []，因此这里不出现 `NaN`/`undefined`；
//   3. 读库失败显示错误文本，**不**伪装成"没有待办"（那会把故障说成空台账）。
//
// 动态结构（D-89 / docs/21 §5）：维度键只来自服务端 spec 的 `dimensions[]`，
// 界面不提供任何"自由输入维度 key"的控件——人只填值，键由服务端锁定。

import { useRef, useState } from 'react'
import {
  fetchFormSpec,
  submitScorecardForm,
  useOverview,
  type OverviewListItem,
  type OverviewResponse,
  type ScorecardFormSpec,
  type ScorecardDimensionValue,
} from './use-overview.ts'
import { RecruitmentHttpError } from './normalize.ts'

/** 六个 actor 视角列表区的配置（顺序即渲染顺序）。 */
const SECTIONS = [
  { key: 'pending_decisions', title: '待决策', countKey: 'pending_total', empty: '没有待决策' },
  { key: 'my_interviews', title: '我的面试', countKey: 'my_interviews_total', empty: '没有我的面试' },
  { key: 'overdue_scorecards', title: '逾期/缺面评', countKey: 'overdue_scorecards_total', empty: '没有逾期/缺面评' },
  { key: 'pending_reviews', title: '待复核材料', countKey: 'pending_reviews_total', empty: '没有待复核材料' },
  {
    key: 'connector_incidents',
    title: '连接器异常',
    countKey: 'connector_incidents_total',
    empty: '没有连接器异常',
    shared: '全租户共享',
  },
  { key: 'waiting_human_tasks', title: '等待人工的任务', countKey: 'waiting_human_total', empty: '没有等待人工的任务' },
] as const

/** 未分配（全租户共享）区块里的四个子区。 */
const UNASSIGNED_SECTIONS = [
  { key: 'pending_decisions', title: '未分配的待决策', empty: '没有未分配的待决策' },
  { key: 'pending_reviews', title: '未分配的待复核材料', empty: '没有未分配的待复核材料' },
  { key: 'waiting_human_tasks', title: '未分配的等待人工任务', empty: '没有未分配的等待人工任务' },
  { key: 'connector_incidents', title: '未分配的连接器异常', empty: '没有未分配的连接器异常' },
] as const

/** 表单区状态：打开中的面试 + spec / 读取错误。 */
interface FormState {
  readonly interviewId: string
  readonly loading: boolean
  readonly spec?: ScorecardFormSpec
  readonly error?: string
}

/** 把 actor_id 取尾 8 位用于展示（避免整串 UUID 淹没标题）。 */
function actorTail(actorId: string): string {
  return actorId.length <= 8 ? actorId : actorId.slice(-8)
}

/** 渲染一条只读列表行（id + 拍平字段 + 可选"填写面评"按钮）。 */
function ItemRow({
  item,
  sectionKey,
  onOpenScorecard,
}: {
  readonly item: OverviewListItem
  readonly sectionKey: string
  readonly onOpenScorecard: (interviewId: string) => void
}) {
  const interviewId = item.interview_id !== '' ? item.interview_id : item.id
  const canOpen = item.needs_scorecard && interviewId !== ''
  return (
    <li data-panel-section={sectionKey} data-item-id={item.id} data-needs-scorecard={item.needs_scorecard ? '1' : '0'}>
      <p>
        <strong>id：{item.id !== '' ? item.id : '（服务端未提供）'}</strong>
      </p>
      {item.fields.map((field) => (
        <p key={field.key} data-field={field.key}>
          {field.label}：{field.value}
        </p>
      ))}
      {canOpen ? (
        <p>
          <button type="button" data-action="open-scorecard" data-interview-id={interviewId} onClick={() => onOpenScorecard(interviewId)}>
            填写面评
          </button>
        </p>
      ) : null}
    </li>
  )
}

/** 渲染一个列表区（标题带服务端计数；空态明确写"没有…"）。 */
function ListSection({
  title,
  count,
  shared,
  empty,
  items,
  sectionKey,
  onOpenScorecard,
}: {
  readonly title: string
  readonly count: number
  readonly shared?: string
  readonly empty: string
  readonly items: readonly OverviewListItem[]
  readonly sectionKey: string
  readonly onOpenScorecard: (interviewId: string) => void
}) {
  return (
    <section data-section={sectionKey}>
      <h3>
        {title}（{count}）{shared !== undefined ? <small>（{shared}）</small> : null}
      </h3>
      {items.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <ItemRow key={`${item.id}-${index}`} item={item} sectionKey={sectionKey} onOpenScorecard={onOpenScorecard} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** 读取 FormData 式 DOM 值（不依赖 React 受控，浏览器脚本可直接 set 值）。 */
function readControl(form: HTMLFormElement, role: string, key: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  for (const element of Array.from(form.querySelectorAll<HTMLElement>(`[data-role="${role}"]`))) {
    if (element.getAttribute('data-dim-key') === key) {
      return element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    }
  }
  return null
}

/** 动态面评表单（D-89）：控件由服务端 spec 生成，提交体由 spec.dimensions 构造。 */
function ScorecardForm({
  state,
  onClose,
  onSubmitted,
}: {
  readonly state: FormState
  readonly onClose: () => void
  readonly onSubmitted: () => void
}) {
  const formRef = useRef<HTMLFormElement | null>(null)
  const [assessments, setAssessments] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | undefined>(undefined)
  const [submitDetail, setSubmitDetail] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<string[] | undefined>(undefined)

  if (state.loading) return <section data-testid="scorecard-form"><p>正在读取面评表单…</p></section>
  if (state.error !== undefined) {
    return (
      <section data-testid="scorecard-form">
        <p role="alert">面评表单读取失败：{state.error}</p>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </section>
    )
  }
  const spec = state.spec
  if (spec === undefined) return null

  const readonlyMode = spec.mode !== 'CREATE'
  const scoringEnabled = (key: string): boolean => assessments[key] === 'MET' || assessments[key] === 'NOT_MET'

  const submit = async (event: { preventDefault(): void; currentTarget: EventTarget & HTMLFormElement }): Promise<void> => {
    event.preventDefault()
    const form = formRef.current ?? event.currentTarget
    const dimensions: Record<string, ScorecardDimensionValue> = {}
    for (const dimension of spec.dimensions) {
      const assessmentElement = readControl(form, 'assessment', dimension.key)
      const assessment = assessmentElement instanceof HTMLSelectElement ? assessmentElement.value : ''
      if (assessment === '') {
        setSubmitError(`维度 ${dimension.label}（${dimension.key}）还没有选择 assessment`)
        setSubmitDetail(undefined)
        return
      }
      let score: number | undefined
      const scoreElement = readControl(form, 'score', dimension.key)
      if (scoreElement instanceof HTMLInputElement && scoringEnabled(dimension.key)) {
        const raw = scoreElement.value.trim()
        if (raw !== '') {
          score = Number(raw)
          if (!Number.isInteger(score) || score < dimension.scoreMin || score > dimension.scoreMax) {
            setSubmitError(`维度 ${dimension.label}（${dimension.key}）的 score 必须是 ${dimension.scoreMin}–${dimension.scoreMax} 的整数`)
            setSubmitDetail(undefined)
            return
          }
        }
      }
      const noteElement = readControl(form, 'note', dimension.key)
      const note = noteElement instanceof HTMLTextAreaElement ? noteElement.value.trim() : ''
      if (dimension.noteRequired && note === '') {
        setSubmitError(`维度 ${dimension.label}（${dimension.key}）要求填写 note`)
        setSubmitDetail(undefined)
        return
      }
      dimensions[dimension.key] = {
        assessment,
        ...(score !== undefined ? { score } : {}),
        ...(note !== '' ? { note } : {}),
      }
    }
    const overallElement = Array.from(form.querySelectorAll<HTMLSelectElement>('[data-role="overall"]'))[0]
    const overall = overallElement === undefined ? '' : overallElement.value
    if (overall === '') {
      setSubmitError('还没有选择 overall 结论')
      setSubmitDetail(undefined)
      return
    }

    setSubmitting(true)
    setSubmitError(undefined)
    setSubmitDetail(undefined)
    try {
      const submitted = await submitScorecardForm({
        interview_id: spec.interview.id !== '' ? spec.interview.id : state.interviewId,
        dimensions,
        transcript_basis: spec.transcript_basis.value,
        overall,
        ...(spec.mode === 'REVISE' && spec.current !== null ? { revision: spec.current.revision_no } : {}),
      })
      const coverageText =
        submitted.coverage === null || submitted.coverage === undefined
          ? '未返回'
          : typeof submitted.coverage === 'string'
            ? submitted.coverage
            : JSON.stringify(submitted.coverage)
      setResult([
        `提交成功：scorecard ${submitted.scorecard.id !== '' ? submitted.scorecard.id : '（服务端未返回 id）'}`,
        `revision_no：${submitted.scorecard.revision_no}`,
        `status：${submitted.scorecard.status !== '' ? submitted.scorecard.status : submitted.status}`,
        `coverage：${coverageText}`,
        `replayed：${submitted.replayed ? '是' : '否'}`,
      ])
      onSubmitted()
    } catch (failure: unknown) {
      if (failure instanceof RecruitmentHttpError) {
        setSubmitError(`提交失败：${failure.message}`)
        setSubmitDetail(
          [
            `code：${failure.code !== '' ? failure.code : '（无）'}`,
            `reason_code：${failure.reasonCode !== '' ? failure.reasonCode : '（无）'}`,
            failure.detail === undefined ? '' : `detail：${JSON.stringify(failure.detail)}`,
          ]
            .filter((line) => line !== '')
            .join(' · '),
        )
      } else {
        setSubmitError(`提交失败：${failure instanceof Error ? failure.message : String(failure)}`)
        setSubmitDetail(undefined)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section data-testid="scorecard-form" data-interview-id={spec.interview.id} data-mode={spec.mode}>
      <h3>面评表单</h3>
      <p>
        面试：第 {spec.interview.round_no} 轮 · {spec.interview.slot_code !== '' ? spec.interview.slot_code : '（未提供 slot）'} ·{' '}
        {spec.interview.status !== '' ? spec.interview.status : '（未提供状态）'}
      </p>
      <p>面试 id：{spec.interview.id}</p>
      <p>
        rubric：{spec.rubric.id !== '' ? spec.rubric.id : '（服务端未提供）'}
        {spec.rubric.payload_hash !== '' ? ` · payload_hash：${spec.rubric.payload_hash}` : ''}
      </p>
      <p data-testid="transcript-basis">
        转写依据（只读）：{spec.transcript_basis.value !== '' ? spec.transcript_basis.value : '（服务端未提供）'}
        {spec.transcript_basis.locked ? '（已锁定）' : ''}
      </p>

      {spec.mode === 'REVISE' ? (
        <p data-testid="mode-revise">
          修订模式：该面试已有面评（revision {spec.current?.revision_no ?? 0}）。本版表单暂只读展示，提交按钮禁用——
          修订提交需服务端 revision 闭环验证后再放开。
        </p>
      ) : null}
      {spec.mode === 'ALREADY_SUBMITTED' ? (
        <p data-testid="mode-submitted">
          该面试已有已提交面评：status {spec.current?.status ?? '（未知）'} · revision {spec.current?.revision_no ?? 0}（本表单只读）
        </p>
      ) : null}

      <form
        ref={formRef}
        data-testid="scorecard-form-fields"
        onSubmit={(event) => {
          if (readonlyMode) {
            event.preventDefault()
            return
          }
          void submit(event)
        }}
      >
        {spec.dimensions.length === 0 ? <p role="alert">服务端没有返回可填写的评分维度，本次面评无法填写，未提交。</p> : null}
        {spec.dimensions.map((dimension) => {
          const enabled = scoringEnabled(dimension.key)
          return (
            <fieldset key={dimension.key} data-dim-key={dimension.key} data-dim-label={dimension.label}>
              <legend>
                {dimension.label}（{dimension.key}）
              </legend>
              <p>
                类型：{dimension.kind !== '' ? dimension.kind : '（未提供）'} · 权重：{dimension.weight}
              </p>
              <label>
                assessment：
                <select
                  data-role="assessment"
                  data-dim-key={dimension.key}
                  value={assessments[dimension.key] ?? ''}
                  disabled={readonlyMode}
                  onChange={(event) => setAssessments((previous) => ({ ...previous, [dimension.key]: event.target.value }))}
                >
                  <option value="">请选择</option>
                  {dimension.assessmentOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                score：
                <input
                  key={enabled ? 'enabled' : 'disabled'}
                  type="number"
                  data-role="score"
                  data-dim-key={dimension.key}
                  min={dimension.scoreMin}
                  max={dimension.scoreMax}
                  disabled={!enabled || readonlyMode}
                />
              </label>
              <label>
                note：
                <textarea data-role="note" data-dim-key={dimension.key} disabled={readonlyMode} rows={2} />
              </label>
            </fieldset>
          )
        })}

        <label>
          overall：
          <select data-role="overall" disabled={readonlyMode}>
            <option value="">请选择</option>
            {spec.overall_options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <p>
          <button type="submit" disabled={submitting || readonlyMode}>
            {submitting ? '正在提交…' : '提交面评'}
          </button>{' '}
          <button type="button" onClick={onClose}>
            关闭表单
          </button>
        </p>
      </form>

      {submitError !== undefined ? (
        <p role="alert" data-testid="submit-error">
          {submitError}
          {submitDetail !== undefined ? `（${submitDetail}）` : ''}
        </p>
      ) : null}
      {result !== undefined ? (
        <div data-testid="submit-result">
          {result.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p>已重新读取总览（reload）。</p>
        </div>
      ) : null}
    </section>
  )
}

/**
 * 「待人工决定」工作台主体（main 面板内容）。
 * @returns 面板 JSX。
 */
export function Workbench() {
  const { data, error, loading, reload } = useOverview()
  const [formState, setFormState] = useState<FormState | undefined>(undefined)

  const openScorecard = (interviewId: string): void => {
    setFormState({ interviewId, loading: true })
    void fetchFormSpec(interviewId)
      .then((spec) => setFormState({ interviewId, loading: false, spec }))
      .catch((failure: unknown) =>
        setFormState({
          interviewId,
          loading: false,
          error: failure instanceof Error ? failure.message : String(failure),
        }),
      )
  }

  const issueText = data !== undefined && data.issues.length > 0 ? data.issues.join('；') : ''
  const configured = data?.configured ?? false
  const showSections = !loading && error === undefined && data !== undefined && configured
  const actor = data?.actor

  return (
    <section data-testid="recruitment-workbench">
      <header>
        <h2>待人工决定</h2>
        <p data-testid="actor-line">
          当前身份：{actor?.display_name !== undefined && actor.display_name !== '' ? actor.display_name : '（服务端未提供 display_name）'}
          {actor !== undefined && actor.actor_id !== '' ? `（${actorTail(actor.actor_id)}）` : ''}
        </p>
        <p data-testid="evaluated-at">
          评估时间：{data?.evaluated_at !== undefined && data.evaluated_at !== '' ? data.evaluated_at : '（服务端未提供）'}
        </p>
        <button type="button" onClick={reload} disabled={loading} data-action="refresh">
          {loading ? '正在读取…' : '刷新'}
        </button>
      </header>

      {error !== undefined ? <p role="alert">读取失败：{error}</p> : null}

      {data !== undefined && !configured ? (
        <p>
          数据库未配置，暂时读不到数据
          {issueText !== '' ? `（缺少：${issueText}）` : ''}
        </p>
      ) : null}

      {data !== undefined && configured && issueText !== '' ? <p>配置问题：{issueText}</p> : null}

      {formState !== undefined ? (
        <ScorecardForm
          key={formState.interviewId}
          state={formState}
          onClose={() => setFormState(undefined)}
          onSubmitted={reload}
        />
      ) : null}

      {loading ? <p>正在读取…</p> : null}

      {showSections && data !== undefined ? (
        <>
          {SECTIONS.map((section) => (
            <ListSection
              key={section.key}
              sectionKey={section.key}
              title={section.title}
              count={data.counts[section.countKey]}
              {...('shared' in section ? { shared: section.shared } : {})}
              empty={section.empty}
              items={data.lists[section.key]}
              onOpenScorecard={openScorecard}
            />
          ))}

          <section data-section="unassigned">
            <h3>未分配（全租户共享）</h3>
            {data.unassigned.note !== '' ? <p>{data.unassigned.note}</p> : null}
            <p>服务端计数：{data.counts.unassigned_total} 条</p>
            {UNASSIGNED_SECTIONS.map((section) => {
              const items = data.unassigned[section.key]
              return (
                <section key={section.key} data-section={`unassigned_${section.key}`}>
                  <h4>{section.title}</h4>
                  {items.length === 0 ? (
                    <p>{section.empty}</p>
                  ) : (
                    <ul>
                      {items.map((item, index) => (
                        <ItemRow
                          key={`${item.id}-${index}`}
                          item={item}
                          sectionKey={`unassigned_${section.key}`}
                          onOpenScorecard={openScorecard}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          </section>
        </>
      ) : null}

      {data?.contract_version !== undefined && data.contract_version !== '' ? (
        <p>
          <small>契约版本：{data.contract_version}</small>
        </p>
      ) : null}
    </section>
  )
}

export default Workbench
