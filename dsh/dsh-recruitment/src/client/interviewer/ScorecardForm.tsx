// 本人独立面评表单（W1 Host Remote Action 的客户端）：
//   打开 → GET form spec（含一次性 nonce）→ 按 spec 的 dimensions 渲染控件
//   → 人逐维度填 assessment/score/note + overall → POST submit → 展示服务端 **DB 读回**
//   → 通知父组件重新 GET overview（禁止只改本地 state 冒充成功）。

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
import {
  clearScorecardDraft,
  fetchScorecardDraft,
  fetchScorecardFormSpec,
  isScorecardEndpointUnavailable,
  readLocalScorecardDraft,
  saveScorecardDraft,
  submitScorecard,
  writeLocalScorecardDraft,
} from './http.ts'

export interface ScorecardFormProps {
  readonly sessionId: string
  readonly interviewId: string
  readonly applicationId: string
  readonly rubricVersionId: string
  readonly round?: RoundEffectiveView
  readonly onClose: () => void
  readonly onSubmitted: () => void
  readonly onUnavailable: () => void
}

interface SubmitFailure {
  readonly code: string
  readonly reasonCode: string
  readonly message: string
}

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

function readControl<T extends HTMLElement>(form: HTMLFormElement, role: string, key: string): T | null {
  for (const element of Array.from(form.querySelectorAll<HTMLElement>(`[data-role="${role}"]`))) {
    if (element.getAttribute('data-dim-key') === key) return element as unknown as T
  }
  return null
}

const NONCE_PROBLEM_CODES = ['NONCE_REQUIRED', 'NONCE_INVALID', 'NONCE_EXPIRED', 'NONCE_ALREADY_USED'] as const

export function ScorecardForm(props: ScorecardFormProps): JSX.Element {
  const formRef = useRef<HTMLFormElement | null>(null)
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
      .then(async (value) => {
        if (!active) return
        setSpec(value)
        const serverDraft = await fetchScorecardDraft({
          sessionId: props.sessionId,
          interviewId: props.interviewId,
          signal: controller.signal,
        })
        if (!active) return
        const restored = serverDraft ?? readLocalScorecardDraft(props.interviewId, props.sessionId)
        if (restored && Object.keys(restored.assessments).length > 0) {
          setAssessments({ ...restored.assessments })
        }
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

  // F1: Scoped by sessionId + interviewId; cancels immediately on switch/unmount
  useEffect(() => {
    if (!spec || spec.mode !== 'CREATE' || Object.keys(assessments).length === 0) return
    let cancelled = false
    const existingLocal = readLocalScorecardDraft(props.interviewId, props.sessionId)
    const draftPayload = { assessments, note: existingLocal?.note ?? '' }
    writeLocalScorecardDraft(props.interviewId, draftPayload, props.sessionId)
    const timer = setTimeout(() => {
      if (cancelled) return
      void saveScorecardDraft({
        sessionId: props.sessionId,
        interviewId: props.interviewId,
        payload: draftPayload,
      }).catch(() => {
        // offline fallback stays in localStorage
      })
    }, 2000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [assessments, props.interviewId, props.sessionId, spec])

  const submit = (event: { preventDefault(): void }): void => {
    event.preventDefault()
    const currentSpec = spec
    const form = formRef.current
    if (currentSpec === undefined) return
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
        void clearScorecardDraft({ sessionId: props.sessionId, interviewId: props.interviewId, scopeKey: props.sessionId })
        setResult(submitted)
        props.onSubmitted()
      })
      .catch((failure: unknown) => {
        const described = describeFailure(failure)
        setSubmitFailure({ code: described.code, reasonCode: described.reasonCode, message: described.message })
      })
      .finally(() => setSubmitting(false))
  }

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
            <strong>服务端面评提交入口暂未就绪</strong>
            <p>本表单不会本地假写，也不会显示假成功；服务端就绪后重新打开即可。</p>
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
            <p>请稍后重试，或联系招聘团队确认当前面试状态。</p>
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
    return shell('ERROR', props.interviewId, <p className="iw-formloading">暂时没能读取到面评表单，请重试。</p>)
  }

  const readonly = spec.mode !== 'CREATE'
  const nonceProblem =
    submitFailure !== undefined && (NONCE_PROBLEM_CODES as readonly string[]).includes(submitFailure.code)
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
        按本轮岗位标准记录你的独立观察。Agent 不会代替面试官提交；提交后实时落库并刷新状态。
      </p>

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
              ? '岗位基础标准'
              : roundSourceText(props.round.focus.source)}
          </p>
          {props.round.focus.available ? (
            <>
              <p>{props.round.focus.title}</p>
              {props.round.focus.description !== '' ? <p className="iw-tiny">{props.round.focus.description}</p> : null}
              {props.round.rubric.dimensions.some((dimension) => dimension.mustCover) ? (
                <p className="iw-tiny" data-testid="scorecard-round-must-cover">
                  本轮必覆盖：
                  {props.round.rubric.dimensions
                    .filter((dimension) => dimension.mustCover)
                    .map((dimension) => dimension.label)
                    .join(' / ')}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {readonly ? (
        <div className="iw-notice iw-notice-warn" data-testid="form-readonly">
          <strong>本场面试你已提交过面评，当前为只读状态。</strong>
        </div>
      ) : null}

      {plan.mismatch ? (
        <div className="iw-notice iw-notice-warn" role="alert" data-testid="round-schema-mismatch">
          <strong>{ROUND_SCHEMA_MISMATCH_TEXT}</strong>
          <p className="iw-tiny">已暂时禁止提交，避免写入不一致的面评，请刷新后重试。</p>
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
          转写依据：<strong>{spec.transcript_basis.value === 'TRANSCRIPT' ? '含面试转写' : '无转写独立评估'}</strong>
        </p>

        {spec.dimensions.length === 0 ? (
          <p className="iw-validation" role="alert">
            当前没有可填写的考核维度，暂时无法提交。
          </p>
        ) : null}

        {plannedFields.map((field) => {
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
                {field.label}
                {field.focus ? ' · 本轮重点' : ''}
                {field.mustCover ? ' · 本轮必覆盖' : ''}
              </legend>
              <p className="iw-fieldhelp">权重：{field.weight}</p>
              <div className="iw-field">
                <span>评估结论：</span>
                <select
                  data-role="assessment"
                  data-dim-key={dimension.key}
                  aria-label={`维度 ${dimension.label} 的评估结论`}
                  value={assessments[dimension.key] ?? ''}
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
              </div>
              <div className="iw-field">
                <span>
                  评分（{dimension.scoreMin}–{dimension.scoreMax} 的整数）：
                </span>
                <input
                  type="number"
                  data-role="score"
                  data-dim-key={dimension.key}
                  aria-label={`维度 ${dimension.label} 的评分`}
                  min={dimension.scoreMin}
                  max={dimension.scoreMax}
                  step={1}
                  disabled={readonly || !scoreEnabled(dimension.key)}
                />
              </div>
              <div className="iw-field">
                <span>观察说明（{dimension.noteRequired ? '必填' : '可选'}）：</span>
                <textarea
                  data-role="note"
                  data-dim-key={dimension.key}
                  aria-label={`维度 ${dimension.label} 的观察说明`}
                  rows={2}
                  maxLength={2000}
                  disabled={readonly}
                />
              </div>
            </fieldset>
          )
        })}

        <fieldset className="iw-fieldset">
          <legend>综合结论</legend>
          <div className="iw-field">
            <span>结论：</span>
            <select
              data-role="overall"
              aria-label="综合结论"
              defaultValue=""
              disabled={readonly || spec.overall_options.length === 0}
            >
              <option value="">
                {spec.overall_options.length === 0 ? '暂无可选结论' : '请选择'}
              </option>
              {spec.overall_options.map((option) => (
                <option key={option} value={option}>
                  {overallText(option)}
                </option>
              ))}
            </select>
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
          <strong>提交未能完成</strong>
          <p>{submitFailure.message || '请检查填写内容后重试（草稿已保留）。'}</p>
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
          <strong>面评已提交</strong>
          <p>已同步写入并刷新「我的面试」列表，本场草稿已自动清理。</p>
        </div>
      ) : null}
    </>,
  )
}
