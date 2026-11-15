// 招聘负责人（Hiring Manager，alias `hiring_manager` / actor …0102）的默认工作视图。
//
// 产品口径：Notion 02 §04 —— 招聘负责人默认首页 = 全局招聘总览，核心工作 = 需求审批、岗位策略、
// 招聘漏斗、综合决策。本视图**只读**展示部门岗位 / 申请 / 待决策 / 面试结果；
// 决策入口按 `work/d5/decision/CONTRACT.md` §4 接 facts + record facade：
//   * facts 404 → disabled + `DECISION_FACTS_ROUTE_MISSING`（不编造 as_of/basis）；
//   * facts 非 200（服务端错误）→ disabled + `DECISION_FACTS_UNAVAILABLE` + 服务端原文；
//   * facts 200 但 summary 不可用 → disabled + `SUMMARY_MISSING`；
//   * 可决策 → POST `/recruitment/api/decision/record`（服务端组装 basis_refs），成功只认 readback。
//
// 写授权：Host Action 只授权 recruiter（`src/http/actions.ts`）。本视图对非授权 alias 不隐藏入口，
// 而是显示精确阻断原因 + 显式「切换为 Recruiter 身份」按钮（不静默换身份）。

import { useEffect, useState } from 'react'
import {
  DECISION_FACTS_PATH,
  DECISION_RECORD_PATH,
  RECRUITING_OVERVIEW_PATH,
  buildDecisionRecordBody,
  deriveHiringView,
  describeActionError,
  isDecisionFactsMissing,
  normalizeDecisionFacts,
  readbackLines,
  requestJson,
  type DecisionFactsView,
  type HiringAppRow,
  type HiringView,
} from './role-api.ts'

const COLORS = {
  text: '#16233a',
  sub: '#64748b',
  border: '#e3e8ef',
  card: '#ffffff',
  blue: '#2f6feb',
  blueBg: '#eef4ff',
  amber: '#92400e',
  amberBg: '#fff7e6',
  red: '#b91c1c',
  green: '#15803d',
} as const

/** 事实投影的加载状态（fail-closed：只有 `ready` 才允许决策）。 */
type FactsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing'; readonly status: number }
  | { readonly kind: 'error'; readonly status: number; readonly message: string }
  | { readonly kind: 'ready'; readonly facts: DecisionFactsView }

/** 一次决策提交的展示结果（成功只认服务端 readback）。 */
interface DecisionOutcome {
  readonly ok: boolean
  readonly status: number
  readonly text: string
  readonly readback: Readonly<Record<string, unknown>> | null
}

/** 招聘负责人视图 props（shell 传入；视图不自行读 localStorage）。 */
export interface HiringManagerViewProps {
  readonly sessionId: string | null
  readonly alias: string | null
  readonly onSwitchAlias: (alias: 'recruiter') => void
}

function Section(props: { title: string; testid: string; children: React.ReactNode; sub?: string }): JSX.Element {
  return (
    <section style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16, marginTop: 14 }} data-testid={props.testid}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{props.title}</h3>
      {props.sub !== undefined ? <p style={{ margin: '0 0 10px', color: COLORS.sub, fontSize: 12 }}>{props.sub}</p> : null}
      {props.children}
    </section>
  )
}

function Chip(props: { children: React.ReactNode; tone?: 'gray' | 'blue' | 'amber' | 'green' }): JSX.Element {
  const tone = props.tone ?? 'gray'
  const palette = {
    gray: { bg: '#f1f5f9', fg: COLORS.sub },
    blue: { bg: COLORS.blueBg, fg: COLORS.blue },
    amber: { bg: COLORS.amberBg, fg: COLORS.amber },
    green: { bg: '#ecfdf5', fg: COLORS.green },
  }[tone]
  return <span style={{ display: 'inline-block', background: palette.bg, color: palette.fg, borderRadius: 999, padding: '2px 9px', fontSize: 11, marginRight: 6 }}>{props.children}</span>
}

/**
 * 招聘负责人默认视图。
 * @param props - shell 传入的 session / alias / 显式切换身份回调。
 * @returns 只读总览 + 决策入口。
 */
export function HiringManagerView(props: HiringManagerViewProps): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [view, setView] = useState<HiringView | null>(null)
  const [selectedAppId, setSelectedAppId] = useState('')
  const [factsState, setFactsState] = useState<FactsState>({ kind: 'idle' })
  const [decisionResult, setDecisionResult] = useState<'ADVANCE' | 'HOLD' | 'REJECT'>('HOLD')
  const [decisionReason, setDecisionReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null)
  const [outcomeNote, setOutcomeNote] = useState('')

  const canWrite = props.alias === 'recruiter'

  const loadOverview = async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await requestJson(RECRUITING_OVERVIEW_PATH, { sessionId: props.sessionId })
      if (!res.ok) {
        setLoadError(`GET ${RECRUITING_OVERVIEW_PATH} → HTTP ${String(res.status)}：${res.text.slice(0, 300)}`)
        setView(null)
        return
      }
      const next = deriveHiringView(res.json)
      setView(next)
      setLoadError('')
      setSelectedAppId((current) => {
        if (current !== '' && next.applications.some((row) => row.id === current)) return current
        const firstPending = next.pendingApplications[0]
        if (firstPending !== undefined) return firstPending.id
        return next.applications[0]?.id ?? ''
      })
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? `网络失败：${error.message}` : String(error))
      setView(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadOverview()
  }, [props.sessionId])

  useEffect(() => {
    if (selectedAppId === '') {
      setFactsState({ kind: 'idle' })
      return
    }
    let cancelled = false
    setFactsState({ kind: 'loading' })
    void (async () => {
      try {
        const res = await requestJson(`${DECISION_FACTS_PATH}?application_id=${encodeURIComponent(selectedAppId)}`, { sessionId: props.sessionId })
        if (cancelled) return
        if (isDecisionFactsMissing(res.status)) {
          setFactsState({ kind: 'missing', status: res.status })
          return
        }
        if (!res.ok || res.json === null) {
          const error = res.json === null ? null : (res.json.error as Readonly<Record<string, unknown>> | undefined)
          const message = error !== undefined && error !== null ? String(error.message ?? '') : res.text.slice(0, 400)
          setFactsState({ kind: 'error', status: res.status, message })
          return
        }
        const facts = normalizeDecisionFacts(res.json)
        if (facts === null) {
          setFactsState({ kind: 'error', status: res.status, message: 'facts 响应缺 application_id（不可归属申请）' })
          return
        }
        setFactsState({ kind: 'ready', facts })
      } catch (error: unknown) {
        if (cancelled) return
        setFactsState({ kind: 'error', status: 0, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.sessionId, selectedAppId])

  const disabledReason = ((): { code: string; text: string } => {
    if (selectedAppId === '') return { code: 'NO_PENDING_DECISION', text: '没有可决策的申请（服务端投影为空）：入口 disabled，不编造申请。' }
    if (factsState.kind === 'missing') {
      return {
        code: 'DECISION_FACTS_ROUTE_MISSING',
        text: `决策 facts 只读投影未接线（GET ${DECISION_FACTS_PATH} → 404）：无法诚实组装 as_of/summary_digest/basis_refs，入口 disabled、零写入。`,
      }
    }
    if (factsState.kind === 'error') {
      return {
        code: 'DECISION_FACTS_UNAVAILABLE',
        text: `决策 facts 读取失败（HTTP ${String(factsState.status)}）：${factsState.message}。入口 disabled，不用浏览器本地时间/编造 basis 顶替。`,
      }
    }
    if (factsState.kind !== 'ready') return { code: 'DECISION_FACTS_LOADING', text: '决策 facts 读取中…' }
    if (!factsState.facts.summaryAvailable) {
      return {
        code: 'SUMMARY_MISSING',
        text: 'facts.evaluation_summary 不可用（available=false）：正式决策需要服务端汇总（summary_digest），入口 disabled、零写入。',
      }
    }
    return { code: '', text: '' }
  })()

  const submitDecision = async (): Promise<void> => {
    if (factsState.kind !== 'ready') return
    const built = buildDecisionRecordBody({
      applicationId: selectedAppId,
      result: decisionResult,
      reason: decisionReason,
      facts: factsState.facts,
    })
    if (!built.ok) {
      setOutcomeNote(`${built.reasonCode}：${built.reasonText}`)
      setOutcome(null)
      return
    }
    setBusy(true)
    setOutcomeNote('')
    try {
      const res = await requestJson(DECISION_RECORD_PATH, { sessionId: props.sessionId, method: 'POST', body: built.body })
      const raw = res.json
      const readback = raw === null ? null : (raw.readback as Readonly<Record<string, unknown>> | undefined) ?? null
      setOutcome({ ok: res.ok, status: res.status, text: res.text.slice(0, 4000), readback: readback !== null && typeof readback === 'object' ? readback : null })
      if (!res.ok) {
        const error = raw === null ? null : (raw.error as Readonly<Record<string, unknown>> | undefined)
        if (error !== undefined && error !== null) {
          setOutcomeNote(`${String(error.code ?? '')}/${String(error.reason_code ?? '')}：${describeActionError(String(error.code ?? ''), String(error.reason_code ?? '')) || String(error.message ?? '')}`)
        }
      } else {
        await loadOverview()
      }
    } catch (error: unknown) {
      setOutcome({ ok: false, status: 0, text: error instanceof Error ? error.message : String(error), readback: null })
    } finally {
      setBusy(false)
    }
  }

  const selectedApp: HiringAppRow | undefined = view?.applications.find((row) => row.id === selectedAppId)
  const disabled = disabledReason.code !== '' || busy
  const factsReady = factsState.kind === 'ready' ? factsState.facts : null

  return (
    <div data-testid="role-view-hiring" data-alias={props.alias ?? ''} style={{ padding: 20, color: COLORS.text, fontSize: 13 }}>
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>招聘负责人工作台 · 部门招聘与决策</h2>
        <p style={{ margin: '6px 0 0', color: COLORS.sub }}>
          只读：部门岗位 / 申请 / 待决策 / 面试结果（来源 GET {RECRUITING_OVERVIEW_PATH}）；决策入口接 Host Action
          （facts + record facade）。当前身份：<b>{props.alias ?? '未绑定'}</b>
        </p>
      </header>

      {!canWrite ? (
        <div data-testid="hiring-write-blocked" style={{ background: COLORS.amberBg, border: '1px solid #f3d9a4', color: COLORS.amber, borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
          当前 alias 不在 Host Action 写授权集合（服务端只授权 recruiter，将 403 ACTOR_NOT_AUTHORIZED、零写入）。
          <button type="button" data-testid="hiring-switch-recruiter" onClick={() => props.onSwitchAlias('recruiter')} style={{ marginLeft: 8, border: `1px solid ${COLORS.border}`, background: '#fff', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>
            切换为 Recruiter 身份执行
          </button>
        </div>
      ) : null}

      {loadError !== '' ? <p style={{ color: COLORS.red }} data-testid="hiring-load-error">读取失败：{loadError}</p> : null}
      {loading ? <p style={{ color: COLORS.sub }}>读取服务端投影…</p> : null}

      {view !== null ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
            <Chip tone="blue">部门岗位 · {String(view.jobs.length)}</Chip>
            <Chip tone="blue">申请 · {String(view.applications.length)}</Chip>
            <Chip tone={view.pendingApplications.length > 0 ? 'amber' : 'gray'}>待决策 · {String(view.pendingApplications.length)}</Chip>
            <Chip tone="gray">已排期面试 · {String(view.interviewsScheduled)}</Chip>
          </div>

          <Section title="部门岗位" testid="hiring-jobs" sub="只读投影；rubric 是否批准来自服务端 jobs[].rubric.approved。">
            {view.jobs.length === 0 ? (
              <p style={{ color: COLORS.sub }}>服务端没有返回岗位。</p>
            ) : (
              view.jobs.slice(0, 30).map((job) => (
                <div key={job.jobId} data-testid={`hiring-job-${job.jobId}`} style={{ borderTop: `1px solid ${COLORS.border}`, padding: '6px 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <b>{job.title}</b>
                  <span style={{ color: COLORS.sub }}>{job.code}</span>
                  <Chip tone="gray">{job.status}</Chip>
                  <Chip tone={job.rubricApproved ? 'green' : 'amber'}>{job.rubricVersionId === '' ? '未关联 rubric' : job.rubricApproved ? 'rubric 已批准' : 'rubric 未批准'}</Chip>
                  <span style={{ color: COLORS.sub }}>申请 {String(job.totalApplications)}（推进中 {String(job.activeApplications)}）</span>
                </div>
              ))
            )}
          </Section>

          <Section title="待决策申请" testid="hiring-pending-decisions" sub="判据 = 服务端 fact：current_stage_code=S10 或 progress.next_step 明确要求决策（不猜）。">
            {view.pendingApplications.length === 0 ? (
              <p style={{ color: COLORS.sub }}>当前没有待决策申请（服务端未给出）。</p>
            ) : (
              view.pendingApplications.slice(0, 20).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  data-testid={`hiring-pending-${row.id}`}
                  onClick={() => setSelectedAppId(row.id)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: `1px solid ${selectedAppId === row.id ? COLORS.blue : COLORS.border}`, background: selectedAppId === row.id ? COLORS.blueBg : '#fff', borderRadius: 8, padding: '6px 8px', marginTop: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  {row.candidateName} · {row.jobTitle} · 阶段 {row.stageCode} · {row.nextStepLabel}
                </button>
              ))
            )}
          </Section>

          <Section title="申请（全量只读）" testid="hiring-applications" sub={`共 ${String(view.applications.length)} 条；点选查看并作为决策对象。`}>
            {view.applications.slice(0, 40).map((row) => (
              <button
                key={row.id}
                type="button"
                data-testid={`hiring-app-${row.id}`}
                onClick={() => setSelectedAppId(row.id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderTop: `1px solid ${COLORS.border}`, background: 'transparent', padding: '5px 0', cursor: 'pointer', fontSize: 12, color: COLORS.text }}
              >
                <b>{row.candidateName}</b> · {row.jobTitle} · {row.stageCode} · {row.lifecycleStatus} · 下一步 {row.nextStepCode}
                {row.awaitingDecision ? <Chip tone="amber">待决策</Chip> : null}
              </button>
            ))}
          </Section>

          <Section title="面试结果（只读事实）" testid="hiring-interview-results" sub="来自 applications[].interviews / progress（服务端只读投影；无则如实为空）。">
            {view.applications.length === 0 ? (
              <p style={{ color: COLORS.sub }}>没有申请，因此没有面试结果。</p>
            ) : (
              view.applications
                .filter((row) => row.interviewCount > 0 || row.scorecardsSubmitted > 0)
                .slice(0, 20)
                .map((row) => (
                  <div key={`ir-${row.id}`} style={{ borderTop: `1px solid ${COLORS.border}`, padding: '5px 0', fontSize: 12 }}>
                    {row.candidateName} · {row.jobTitle} · 面试 {String(row.interviewCount)} 场 · 面评 {String(row.scorecardsSubmitted)}/{String(row.scorecardsRequired)} · 转写 {row.transcriptState}
                  </div>
                ))
            )}
          </Section>

          <Section
            title="决策入口（正式决策 FINAL）"
            testid="hiring-decision-panel"
            sub={`对象：${selectedApp === undefined ? '未选择申请' : `${selectedApp.candidateName} · ${selectedApp.jobTitle}（${selectedApp.id}）`}；facts 来自 GET ${DECISION_FACTS_PATH}，body 不含 hash/digest。`}
          >
            {disabledReason.code !== '' ? (
              <p data-testid="hiring-decision-reason" data-reason-code={disabledReason.code} style={{ color: COLORS.amber, fontSize: 12 }}>
                [{disabledReason.code}] {disabledReason.text}
              </p>
            ) : (
              <p data-testid="hiring-decision-reason" style={{ color: COLORS.green, fontSize: 12 }}>
                facts 可用（summary available，as_of={factsReady?.asOf ?? ''}）；勾选结论并填写理由后提交。
              </p>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <select aria-label="决策结论" data-testid="hiring-decision-result" value={decisionResult} onChange={(event) => setDecisionResult(event.target.value as 'ADVANCE' | 'HOLD' | 'REJECT')} disabled={disabled} style={{ fontSize: 12, padding: '5px 8px' }}>
                <option value="HOLD">HOLD（暂缓）</option>
                <option value="ADVANCE">ADVANCE（推进）</option>
                <option value="REJECT">REJECT（拒绝）</option>
              </select>
              <input data-testid="hiring-decision-reason-input" aria-label="决策理由" placeholder="决策理由（必填，人写的理由）" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} disabled={disabled} style={{ fontSize: 12, padding: '5px 8px', width: 360 }} />
              <button
                type="button"
                data-testid="hiring-decision-entry"
                data-state={disabledReason.code === '' ? 'enabled' : 'disabled'}
                data-reason-code={disabledReason.code}
                disabled={disabled}
                onClick={() => void submitDecision()}
                style={{ border: `1px solid ${COLORS.border}`, background: disabled ? '#f1f5f9' : COLORS.blue, color: disabled ? COLORS.sub : '#fff', borderRadius: 8, padding: '6px 12px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12 }}
              >
                {busy ? '提交中…' : '记录正式决策'}
              </button>
            </div>
            {outcomeNote !== '' ? <p data-testid="hiring-action-note" style={{ color: COLORS.amber, fontSize: 12 }}>{outcomeNote}</p> : null}
            {outcome !== null ? (
              <div data-testid="hiring-decision-readback" data-ok={outcome.ok ? 'true' : 'false'} data-status={String(outcome.status)} style={{ marginTop: 8, fontSize: 12 }}>
                <b>{outcome.ok ? '服务端已受理（事实以 readback 为准）' : `失败 HTTP ${String(outcome.status)}`}</b>
                {outcome.readback !== null ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {readbackLines(outcome.readback).map((line) => (
                      <li key={line.key}><code>{line.key}</code>：{line.value}</li>
                    ))}
                  </ul>
                ) : (
                  <pre data-testid="hiring-action-error" style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 8, borderRadius: 8, fontSize: 11 }}>{outcome.text}</pre>
                )}
              </div>
            ) : null}
          </Section>
        </>
      ) : null}
    </div>
  )
}
