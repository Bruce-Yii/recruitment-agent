// 本人独立面评表单（W1 Host Remote Action 的客户端）：
//   打开 → GET form spec（含一次性 nonce）→ 按 spec 的 dimensions 渲染控件
//   → 人逐维度填 assessment/score/note + overall → POST submit → 展示服务端 **DB 读回**
//   → 通知父组件重新 GET overview（禁止只改本地 state 冒充成功）。
//
// 四条硬约束：
//   1. 维度键**只**来自 W1 form spec（`dimensions[].key`）：表单不提供任何"自由输入维度键"的控件；
//      `buildScorecardSubmitBody` 在本地就拒绝缺维度 / 未知枚举，绝不把前端自由键发给服务端。
//   2. W1 端点未就绪（404/405/网络错）→ 提交按钮 `disabled` + 明确文案「服务端面评提交入口未就绪（W1）」；
//      **不做**假 Toast、不写 localStorage、不把失败说成成功。
//   3. 失败（403/409/400）→ 显示 code / reason_code / message；本地"已提交"状态不变。
//   4. `transcript_basis` 用服务端锁定值：转写缺失不是提交失败（服务端记 NO_TRANSCRIPT，D-111）。

import { useEffect, useRef, useState } from 'react'
import {
  assessmentText,
  buildScorecardSubmitBody,
  overallText,
  RecruitmentHttpError,
  type ScorecardAnswers,
  type ScorecardDimensionAnswer,
  type ScorecardFormSpec,
  type ScorecardSubmitResult,
} from './normalize.ts'
import { deriveScorecardFields, roundSourceText, ROUND_SCHEMA_MISMATCH_TEXT, type RoundEffectiveView } from './round.ts'
import { fetchScorecardFormSpec, isScorecardEndpointUnavailable, submitScorecard } from './http.ts'

/** 表单组件的入参（数据只来自父组件 props 与 W1 HTTP，不读 localStorage）。 */
export interface ScorecardFormProps {
  readonly sessionId: string
  readonly interviewId: string
  /** 用于 W1 nonce 绑定校验（与 interview 一致；服务端会再核一遍）。 */
  readonly applicationId: string
  /** 申请钉住的 rubric 版本（可为空：不猜版本）。 */
  readonly rubricVersionId: string
  /** 本场轮次投影（task-50）：只用于展示本轮重点/顺序/标注与一致性核对，提交键集仍只认 W1 spec。 */
  readonly round?: RoundEffectiveView
  readonly onClose: () => void
  /** 提交成功后通知父组件重新 GET overview（服务端事实，不许只改本地 state）。 */
  readonly onSubmitted: () => void
  /** 发现 W1 form 端点未就绪时通知父组件（父组件据此禁用入口并显示文案）。 */
  readonly onUnavailable: () => void
}

/** 提交失败的契约字段（界面按 code/reason_code 原样展示）。 */
interface SubmitFailure {
  readonly code: string
  readonly reasonCode: string
  readonly message: string
}

/** 把任意错误拆成可展示的 {code,reasonCode,message,status}。 */
function describeFailure(failure: unknown): { code: string; reasonCode: string; message: string; status: number } {
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

/** 从表单 DOM 里按 role + 维度键找一个控件（键来自 spec；用属性比较避免选择器转义问题）。 */
function readControl<T extends HTMLElement>(form: HTMLFormElement, role: string, key: string): T | null {
  for (const element of Array.from(form.querySelectorAll<HTMLElement>(`[data-role="${role}"]`))) {
    if (element.getAttribute('data-dim-key') === key) return element as unknown as T
  }
  return null
}

/** 一次性 nonce 失效：提示并允许重新取 spec（重新打开表单等价动作）。 */
const NONCE_PROBLEM_CODES = ['NONCE_REQUIRED', 'NONCE_INVALID', 'NONCE_EXPIRED', 'NONCE_ALREADY_USED'] as const

/**
 * 面评表单。
 * @param props - sessionId / interviewId / applicationId / rubricVersionId / 回调。
 * @returns 表单弹层 JSX。
 */
export function ScorecardForm(props: ScorecardFormProps): JSX.Element {
  const formRef = useRef<HTMLFormElement | null>(null)
  /** 最新回调引用：避免把回调放进 fetch effect 依赖造成循环重取。 */
  const onUnavailableRef = useRef(props.onUnavailable)
  const onCloseRef = useRef(props.onClose)

  const [spec, setSpec] = useState<ScorecardFormSpec | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [loadFailure, setLoadFailure] = useState<unknown>(undefined)
  const [generation, setGeneration] = useState(0)
  const [assessments, setAssessments] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [validationError, setValidationError] = useState('')
  const [submitFailure, setSubmitFailure] = useState<SubmitFailure | undefined>(undefined)
  const [result, setResult] = useState<ScorecardSubmitResult | undefined>(undefined)

  useEffect(() => {
    onUnavailableRef.current = props.onUnavailable
    onCloseRef.current = props.onClose
  }, [props.onUnavailable, props.onClose])

  // Escape 关闭（与原型一致；不依赖宿主是否提供模态层）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 打开/重取 spec：sessionId / interviewId / applicationId / 申请钉住的 rubric 变化都重新取。
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setLoadFailure(undefined)
    setSubmitFailure(undefined)
    setValidationError('')
    setResult(undefined)
    setAssessments({})
    fetchScorecardFormSpec({
      sessionId: props.sessionId,
      interviewId: props.interviewId,
      applicationId: props.applicationId,
      rubricVersionId: props.rubricVersionId,
      signal: controller.signal,
    })
      .then((value) => {
        if (!active) return
        setSpec(value)
      })
      .catch((failure: unknown) => {
        if (!active || controller.signal.aborted) return
        setLoadFailure(failure)
        if (isScorecardEndpointUnavailable(failure)) onUnavailableRef.current()
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [props.sessionId, props.interviewId, props.applicationId, props.rubricVersionId, generation])

  const submit = (event: { preventDefault(): void }): void => {
    event.preventDefault()
    const currentSpec = spec
    const form = formRef.current
    if (currentSpec === undefined) return
    // 二次 fail-closed：即使按钮 disabled 被绕过（DOM 注入/键盘），也绝不把矛盾 schema 提交写库。
    if (deriveScorecardFields(currentSpec, props.round).mismatch) {
      setValidationError(ROUND_SCHEMA_MISMATCH_TEXT)
      setSubmitFailure(undefined)
      return
    }
    if (form === null) {
      setValidationError('表单尚未渲染，无法提交。')
      return
    }
    const answers: Record<string, ScorecardDimensionAnswer> = {}
    for (const dimension of currentSpec.dimensions) {
      const assessmentElement = readControl<HTMLSelectElement>(form, 'assessment', dimension.key)
      const scoreElement = readControl<HTMLInputElement>(form, 'score', dimension.key)
      const noteElement = readControl<HTMLTextAreaElement>(form, 'note', dimension.key)
      const answer: { assessment: string; score?: number; note?: string } = {
        assessment: assessmentElement?.value ?? '',
      }
      if (scoreElement !== null && scoreElement.value.trim() !== '') {
        const parsed = Number(scoreElement.value)
        if (Number.isFinite(parsed)) answer.score = parsed
      }
      if (noteElement !== null && noteElement.value.trim() !== '') answer.note = noteElement.value.trim()
      answers[dimension.key] = answer
    }
    const overallElement = form.querySelector<HTMLSelectElement>('[data-role="overall"]')
    const overall = overallElement?.value ?? ''
    const payload: ScorecardAnswers = { dimensions: answers, overall }
    const built = buildScorecardSubmitBody(currentSpec, payload)
    if (!built.ok) {
      setValidationError(built.message)
      setSubmitFailure(undefined)
      return
    }
    setValidationError('')
    setSubmitFailure(undefined)
    setSubmitting(true)
    void submitScorecard({ sessionId: props.sessionId, body: built.body })
      .then((submitted) => {
        setResult(submitted)
        props.onSubmitted()
      })
      .catch((failure: unknown) => {
        const described = describeFailure(failure)
        setSubmitFailure({ code: described.code, reasonCode: described.reasonCode, message: described.message })
      })
      .finally(() => setSubmitting(false))
  }

  /** 统一的弹层外壳：`[data-testid="scorecard-form"]` 永远是打开状态下的根锚点。 */
  const shell = (mode: string, interviewId: string, children: JSX.Element): JSX.Element => (
    <section
      className="iw-overlay"
      data-testid="scorecard-form"
      data-mode={mode}
      data-interview-id={interviewId}
      aria-label="我的独立面评"
    >
      <div className="iw-modal" role="dialog" aria-modal="true" aria-label="我的独立面评">
        <div className="iw-modaltop">
          <h2>我的独立面评</h2>
          <button type="button" className="iw-x" onClick={props.onClose} aria-label="关闭面评表单">
            ×
          </button>
        </div>
        {children}
      </div>
    </section>
  )

  if (loading) {
    return shell('LOADING', props.interviewId, <p className="iw-formloading">正在读取面评表单…</p>)
  }

  if (loadFailure !== undefined) {
    const unavailable = isScorecardEndpointUnavailable(loadFailure)
    const described = describeFailure(loadFailure)
    return shell(
      unavailable ? 'UNAVAILABLE' : 'ERROR',
      props.interviewId,
      <>
        {unavailable ? (
          <div className="iw-notice iw-notice-warn" role="alert" data-testid="scorecard-unavailable">
            <strong>服务端面评提交入口未就绪</strong>
            <p>
              读取面评表单失败（HTTP {described.status}）。本表单不会本地假写，也不会显示假成功；服务端就绪后重新打开即可。
            </p>
          </div>
        ) : (
          <div
            className="iw-errorbox"
            role="alert"
            data-testid="form-load-error"
            data-code={described.code}
            data-reason-code={described.reasonCode}
          >
            <strong>面评表单读取失败</strong>
            <p>{described.message}</p>
            <p>
              code：{described.code !== '' ? described.code : '（无）'} · reason_code：
              {described.reasonCode !== '' ? described.reasonCode : '（无）'}
            </p>
          </div>
        )}
        <div className="iw-modalend">
          <button type="button" className="iw-btn" onClick={props.onClose}>
            关闭
          </button>
          <button type="submit" data-testid="submit-scorecard" className="iw-btn iw-btn-blue" disabled>
            提交我的独立面评
          </button>
        </div>
      </>,
    )
  }

  if (spec === undefined) {
    // 理论上走不到（loading 结束且无 loadFailure 时 spec 必有值）；兜底 fail-closed。
    return shell('ERROR', props.interviewId, <p className="iw-formloading">服务端没有返回面评表单，表单未提交。</p>)
  }

  const readonly = spec.mode !== 'CREATE'
  const nonceProblem =
    submitFailure !== undefined && (NONCE_PROBLEM_CODES as readonly string[]).includes(submitFailure.code)
  // 本轮 effective schema → 表单计划：顺序/标签/权重/重点标记用它覆盖；**提交键集仍只认 spec**。
  // 服务端两套事实不一致（submission.dimension_keys ≠ spec keys / effective 含 spec 外 key）→ mismatch，
  // 界面必须 fail-closed（禁用提交，不写脏面评），见契约 §4.2。
  const plan = deriveScorecardFields(spec, props.round)
  const plannedFields = plan.fields
  const submitDisabled =
    submitting ||
    readonly ||
    spec.dimensions.length === 0 ||
    spec.overall_options.length === 0 ||
    spec.transcript_basis.value === '' ||
    spec.nonce === '' ||
    plan.mismatch ||
    plannedFields.length === 0
  const scoreEnabled = (key: string): boolean => assessments[key] === 'MET' || assessments[key] === 'NOT_MET'

  return shell(
    spec.mode,
    spec.interview.id !== '' ? spec.interview.id : props.interviewId,
    <>
      <p className="iw-modaldesc">
        按本轮评分标准记录你的独立观察。Agent 不代替面试官提交；提交后会回显服务端保存结果。
      </p>

      {/* 本轮考察重点（只读上下文）：轮次配置存在时展示；JOB_BASE 降级时只说事实，不伪造重点。 */}
      {props.round !== undefined ? (
        <div
          className="iw-roundctx"
          data-testid="scorecard-round-context"
          data-round-source={
            props.round.serverFieldsMissing || !props.round.focus.available
              ? 'JOB_BASE'
              : props.round.focus.source !== ''
                ? props.round.focus.source
                : 'JOB_BASE'
          }
          data-round-no={props.round.focus.round_no > 0 ? props.round.focus.round_no : spec.interview.round_no}
          data-round-available={props.round.focus.available ? '1' : '0'}
          data-round-schema-source={props.round.rubric.source}
          data-round-dimension-count={props.round.rubric.dimensions.length}
        >
          <strong>本轮考察重点（只读）</strong>
          <p className="iw-tiny iw-muted">
            {props.round.serverFieldsMissing || !props.round.focus.available
              ? '岗位通用标准（服务端未提供该轮专属配置）'
              : roundSourceText(props.round.focus.source)}
          </p>
          {props.round.focus.available ? (
            <>
              <p>{props.round.focus.title}</p>
              {props.round.focus.description !== '' ? <p className="iw-tiny">{props.round.focus.description}</p> : null}
              {props.round.rubric.dimensions.some((dimension) => dimension.mustCover) ? (
                <p className="iw-tiny" data-testid="scorecard-round-must-cover">
                  {/* “本轮必覆盖”只认 effective_rubric.dimensions.must_cover（不是 round_focus.required，后者是模板 required）。 */}
                  本轮必覆盖：
                  {props.round.rubric.dimensions
                    .filter((dimension) => dimension.mustCover)
                    .map((dimension) => dimension.label)
                    .join(' / ')}
                </p>
              ) : null}
              {props.round.rubric.scaleMin !== 0 || props.round.rubric.scaleMax !== 0 ? (
                <p className="iw-tiny iw-muted">
                  本轮评分区间：{props.round.rubric.scaleMin}–{props.round.rubric.scaleMax}
                </p>
              ) : null}
            </>
          ) : (
            <p className="iw-tiny iw-muted">
              服务端未提供该轮专属配置（按岗位通用标准展示）；提交仍按服务端下发的评分维度，界面不编造本轮重点。
            </p>
          )}
        </div>
      ) : null}
      <p className="iw-tiny iw-muted">
        面试：第 {spec.interview.round_no} 轮 · {spec.interview.slot_code !== '' ? spec.interview.slot_code : '（未提供 slot）'} ·
        状态：{spec.interview.status !== '' ? spec.interview.status : '（未提供）'} · rubric：
        <span className="iw-mono">{spec.rubric.id !== '' ? spec.rubric.id : '（未提供）'}</span>
      </p>

      {readonly ? (
        <div className="iw-notice iw-notice-warn" data-testid="form-readonly">
          <strong>该面试已有当前面评（服务端 mode={spec.mode}），本版表单只读。</strong>
          <p>修订提交需要服务端 revision 闭环（supersedes_scorecard_id / expected_record_version），本版不开放，避免本地伪造修订。</p>
        </div>
      ) : null}

      {plan.mismatch ? (
        <div className="iw-notice iw-notice-warn" role="alert" data-testid="round-schema-mismatch">
          <strong>{ROUND_SCHEMA_MISMATCH_TEXT}</strong>
          <p className="iw-tiny">{plan.mismatchText}</p>
          <p className="iw-tiny">已禁用提交：未写库，避免产生错误面评。请修正本轮评分表与面评表单后重试。</p>
        </div>
      ) : null}

      <form
        className="iw-form"
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault()
          submit(event)
        }}
      >
        <p className="iw-lockline" data-testid="transcript-basis">
          转写依据（服务端锁定）：
          <strong>{spec.transcript_basis.value !== '' ? spec.transcript_basis.value : '（未提供）'}</strong>
          {spec.transcript_basis.locked ? '（locked）' : ''}
        </p>

        {spec.dimensions.length === 0 ? (
          <p className="iw-validation" role="alert">
            服务端没有返回可填写的评分维度，无法提交（未提交）。
          </p>
        ) : null}

        {plannedFields.map((field) => {
          // 控件（assessment 枚举 / 分数区间 / note 必填）**只**来自 W1 form spec；展示信息可被本轮 schema 覆盖。
          const dimension = field.spec
          return (
            <fieldset
              className="iw-fieldset"
              data-dim-key={dimension.key}
              data-field-source={field.overridden ? 'ROUND' : 'SPEC'}
              data-focus={field.focus ? '1' : '0'}
              data-must-cover={field.mustCover ? '1' : '0'}
              key={dimension.key}
            >
              <legend>
                {field.label}（{dimension.key}）
                {field.focus ? ' · 本轮重点' : ''}
                {field.mustCover ? ' · 本轮必覆盖' : ''}
              </legend>
              <p className="iw-fieldhelp">
                类型：{dimension.kind !== '' ? dimension.kind : '未提供'} · 权重：{field.weight}
                {field.overridden
                  ? ` · 按本轮标准调整（来源：${field.origin !== '' ? field.origin : '未提供'}）`
                  : ''}
              </p>
              <div className="iw-field">
                <span>assessment：</span>
                <select
                  data-role="assessment"
                  data-dim-key={dimension.key}
                  aria-label={`维度 ${dimension.label} 的 assessment`}
                  defaultValue=""
                  disabled={readonly}
                  onChange={(event) =>
                    setAssessments((previous) => ({ ...previous, [dimension.key]: event.target.value }))
                  }
                >
                  <option value="">请选择</option>
                  {dimension.assessmentOptions.map((option) => (
                    <option key={option} value={option}>
                      {assessmentText(option)}
                    </option>
                  ))}
                </select>
                {dimension.assessmentOptions.length === 0 ? (
                  <p className="iw-fieldhelp">服务端未给该维度的可选项（不可提交，未提交）。</p>
                ) : null}
              </div>
              <div className="iw-field">
                <span>
                  score（仅 MET / NOT_MET，{dimension.scoreMin}–{dimension.scoreMax} 的整数）：
                </span>
                <input
                  type="number"
                  data-role="score"
                  data-dim-key={dimension.key}
                  aria-label={`维度 ${dimension.label} 的 score`}
                  min={dimension.scoreMin}
                  max={dimension.scoreMax}
                  step={1}
                  disabled={readonly || !scoreEnabled(dimension.key)}
                />
              </div>
              <div className="iw-field">
                <span>note（{dimension.noteRequired ? '必填' : '可选'}，≤2000 字）：</span>
                <textarea
                  data-role="note"
                  data-dim-key={dimension.key}
                  aria-label={`维度 ${dimension.label} 的 note`}
                  rows={2}
                  maxLength={2000}
                  disabled={readonly}
                />
              </div>
            </fieldset>
          )
        })}

        <fieldset className="iw-fieldset">
          <legend>综合结论（overall）</legend>
          <div className="iw-field">
            <span>overall：</span>
            <select
              data-role="overall"
              aria-label="overall 综合结论"
              defaultValue=""
              disabled={readonly || spec.overall_options.length === 0}
            >
              <option value="">
                {spec.overall_options.length === 0 ? '服务端未提供综合结论选项（未提交）' : '请选择'}
              </option>
              {spec.overall_options.map((option) => (
                <option key={option} value={option}>
                  {overallText(option)}
                </option>
              ))}
            </select>
            <p className="iw-fieldhelp">
              枚举只来自服务端；选择 REJECT 时服务端要求拒绝理由（本版表单未提供该输入，可能被服务端拒绝——不本地编造）。
            </p>
          </div>
        </fieldset>

        <div className="iw-modalend">
          <button type="button" className="iw-btn" onClick={props.onClose}>
            取消
          </button>
          <button type="submit" data-testid="submit-scorecard" className="iw-btn iw-btn-blue" disabled={submitDisabled}>
            {submitting ? '正在提交…' : '提交我的独立面评'}
          </button>
        </div>
      </form>

      {validationError !== '' ? (
        <p className="iw-validation" role="alert" data-testid="form-validation-error">
          {validationError}
        </p>
      ) : null}

      {submitFailure !== undefined ? (
        <div
          className="iw-errorbox"
          role="alert"
          data-testid="submit-error"
          data-code={submitFailure.code}
          data-reason-code={submitFailure.reasonCode}
        >
          <strong>提交失败（服务端返回）</strong>
          <p>{submitFailure.message}</p>
          <p>
            code：{submitFailure.code !== '' ? submitFailure.code : '（无）'} · reason_code：
            {submitFailure.reasonCode !== '' ? submitFailure.reasonCode : '（无）'}
          </p>
          {nonceProblem ? (
            <p>
              <button
                type="button"
                className="iw-btn iw-btn-sm"
                data-testid="scorecard-refetch"
                onClick={() => {
                  setSpec(undefined)
                  setGeneration((value) => value + 1)
                }}
              >
                重新获取表单
              </button>
            </p>
          ) : null}
        </div>
      ) : null}

      {result !== undefined ? (
        <div
          className="iw-result"
          data-testid="submit-result"
          data-scorecard-id={result.scorecard_id}
          data-status={result.status}
          data-actor-id={result.actor_id}
          data-record-version={String(result.record_version)}
        >
          <strong>提交成功：服务端 DB 读回</strong>
          <p>
            scorecard_id：<code>{result.scorecard_id !== '' ? result.scorecard_id : '（服务端未返回）'}</code>
          </p>
          <p>
            status：<code>{result.status !== '' ? result.status : '（服务端未返回）'}</code> · record_version：
            <code>{result.record_version}</code> · replayed：{result.replayed ? '是' : '否'}
          </p>
          <p>
            actor_id：<code>{result.actor_id !== '' ? result.actor_id : '（服务端未返回）'}</code>
          </p>
          <p>
            interviewer_id：<code>{result.interviewer_id !== '' ? result.interviewer_id : '（服务端未返回）'}</code> · interview_id：
            <code>{result.interview_id !== '' ? result.interview_id : '（服务端未返回）'}</code>
          </p>
          {result.scorecard_id === '' || result.status === '' ? (
            <p>服务端读回不完整（缺 scorecard_id/status），请勿仅凭本回显认定已写库。</p>
          ) : null}
          <p>已重新读取「我的面试」（overview reload）。</p>
        </div>
      ) : null}
    </>,
  )
}
