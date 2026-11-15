// 审批人 / 企业管理员（alias `approver` / actor …0101）的默认工作视图。
//
// 产品口径：Notion 02 §04 —— 审批人默认首页 = 待审批事项；企业管理员 = 企业配置与连接状态。
// v1.0 最小实现：
//   * 待批准 Rubric 列表：来源 = `GET /recruitment/api/recruiting/overview` 的岗位投影
//     `jobs[].rubric`（`rubric_version_id` 非空且 `approved !== true`）。**approval 表没有只读投影**
//     （`work/d5/roles/CONTRACT.md` §6），UI 如实标注来源，不冒充直读 approval 表；
//   * 批准入口：POST `/recruitment/api/action/job/rubric-approve`（Host Action，人类点击 = allow-once）；
//     成功事实只认信封 `readback`，随后重新 GET overview；
//   * 拒绝入口：Host Action 契约里**没有** rubric 拒绝端点 → disabled + 精确原因（零写入）；
//   * 招聘设置（ORG_ADMIN 职责）：team create → POST `/recruitment/api/action/config`，显示 readback。
//
// 写授权：Host Action 只授权 recruiter alias。approver 点击会被服务端 403 ACTOR_NOT_AUTHORIZED（零写入）；
// 视图如实展示服务端原文 + 显式「切换为 Recruiter 身份执行」按钮（不静默换身份）。

import { useEffect, useState } from 'react'
import {
  CONFIG_PATH,
  RECRUITING_OVERVIEW_PATH,
  RUBRIC_APPROVE_PATH,
  buildRubricApproveBody,
  buildSettingsTeamCreateBody,
  derivePendingRubricApprovals,
  describeActionError,
  parseActionEnvelope,
  readbackLines,
  requestJson,
  type PendingRubricRow,
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

/** 一次写动作的展示结果（成功只认 readback）。 */
interface ActionOutcome {
  readonly key: string
  readonly ok: boolean
  readonly status: number
  readonly bodyText: string
  readonly readback: Readonly<Record<string, unknown>> | null
  readonly approval: { readonly result: string } | null
  readonly errorCode: string
  readonly errorReason: string
  readonly errorMessage: string
}

/** 审批视图 props（shell 传入）。 */
export interface ApproverViewProps {
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

function ReadbackBlock(props: { outcome: ActionOutcome; testid: string }): JSX.Element {
  const lines = readbackLines(props.outcome.readback)
  return (
    <div
      data-testid={props.testid}
      data-ok={props.outcome.ok ? 'true' : 'false'}
      data-status={String(props.outcome.status)}
      data-approval-id={props.outcome.readback !== null ? String((props.outcome.readback as Record<string, unknown>).approval !== undefined ? ((props.outcome.readback as Record<string, unknown>).approval as Record<string, unknown>)?.approval_id ?? '' : '') : ''}
      style={{ marginTop: 8, fontSize: 12 }}
    >
      <b>{props.outcome.ok ? `服务端已受理（HTTP ${String(props.outcome.status)}；事实以 readback 为准）` : `失败（HTTP ${String(props.outcome.status)}）`}</b>
      {props.outcome.approval !== null ? <p style={{ margin: '4px 0' }}>approval.result = <code>{props.outcome.approval.result}</code></p> : null}
      {props.outcome.ok && lines.length > 0 ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {lines.map((line) => (
            <li key={line.key}><code>{line.key}</code>：{line.value}</li>
          ))}
        </ul>
      ) : null}
      {!props.outcome.ok ? (
        <>
          {props.outcome.errorCode !== '' ? (
            <p style={{ color: COLORS.red, margin: '4px 0' }}>
              {props.outcome.errorCode}/{props.outcome.errorReason}：{describeActionError(props.outcome.errorCode, props.outcome.errorReason) || props.outcome.errorMessage}
            </p>
          ) : null}
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 8, borderRadius: 8, fontSize: 11, maxHeight: 240, overflow: 'auto' }}>{props.outcome.bodyText.slice(0, 4000)}</pre>
        </>
      ) : null}
    </div>
  )
}

/**
 * 审批人默认视图：待批准 Rubric + 招聘设置（team create）。
 * @param props - shell 传入的 session / alias / 显式切换身份回调。
 * @returns 审批工作台。
 */
export function ApproverView(props: ApproverViewProps): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [rows, setRows] = useState<readonly PendingRubricRow[]>([])
  const [departments, setDepartments] = useState<readonly { readonly id: string; readonly name: string }[]>([])
  const [busyKey, setBusyKey] = useState('')
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null)
  const [settingsOutcome, setSettingsOutcome] = useState<ActionOutcome | null>(null)
  const [teamCode, setTeamCode] = useState('')
  const [teamName, setTeamName] = useState('')
  const [teamDepartmentId, setTeamDepartmentId] = useState('')
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsNote, setSettingsNote] = useState('')
  const [manualJobId, setManualJobId] = useState('')
  const [manualRubricId, setManualRubricId] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  const [manualOutcome, setManualOutcome] = useState<ActionOutcome | null>(null)
  const [manualNote, setManualNote] = useState('')

  const canWrite = props.alias === 'recruiter'

  const loadOverview = async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await requestJson(RECRUITING_OVERVIEW_PATH, { sessionId: props.sessionId })
      if (!res.ok) {
        setLoadError(`GET ${RECRUITING_OVERVIEW_PATH} → HTTP ${String(res.status)}：${res.text.slice(0, 300)}`)
        setRows([])
        return
      }
      const raw = res.json ?? {}
      setRows(derivePendingRubricApprovals(raw))
      const settings = typeof raw.settings === 'object' && raw.settings !== null ? raw.settings as Record<string, unknown> : {}
      const rawDepartments = Array.isArray(settings.departments) ? settings.departments : []
      const nextDepartments: { id: string; name: string }[] = []
      for (const item of rawDepartments) {
        const department = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
        const id = typeof department.department_id === 'string' ? department.department_id : ''
        if (id === '') continue
        nextDepartments.push({ id, name: typeof department.name === 'string' ? department.name : id })
      }
      setDepartments(nextDepartments)
      setTeamDepartmentId((current) => (current !== '' ? current : nextDepartments[0]?.id ?? ''))
      setLoadError('')
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? `网络失败：${error.message}` : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadOverview()
  }, [props.sessionId])

  const pickError = (res: Awaited<ReturnType<typeof requestJson>>): { code: string; reason: string; message: string } => {
    const error = res.json === null ? null : (res.json.error as Record<string, unknown> | undefined)
    return {
      code: error !== undefined && error !== null && typeof error.code === 'string' ? error.code : '',
      reason: error !== undefined && error !== null && typeof error.reason_code === 'string' ? error.reason_code : '',
      message: error !== undefined && error !== null && typeof error.message === 'string' ? error.message : res.text.slice(0, 400),
    }
  }

  const approveRubric = async (row: PendingRubricRow): Promise<void> => {
    const built = buildRubricApproveBody({ jobId: row.jobId, rubricVersionId: row.rubricVersionId })
    if (!built.ok) {
      setOutcome({ key: row.jobId, ok: false, status: 0, bodyText: `${built.reasonCode}：${built.reasonText}`, readback: null, approval: null, errorCode: built.reasonCode, errorReason: '', errorMessage: built.reasonText })
      return
    }
    setBusyKey(row.jobId)
    try {
      const res = await requestJson(RUBRIC_APPROVE_PATH, { sessionId: props.sessionId, method: 'POST', body: built.body })
      const envelope = parseActionEnvelope(res.text)
      const error = pickError(res)
      setOutcome({
        key: row.jobId,
        ok: res.ok,
        status: res.status,
        bodyText: res.text,
        readback: envelope?.readback ?? null,
        approval: envelope === null ? null : { result: envelope.approval.result },
        errorCode: error.code,
        errorReason: error.reason,
        errorMessage: error.message,
      })
      if (res.ok) await loadOverview()
    } catch (error: unknown) {
      setOutcome({ key: row.jobId, ok: false, status: 0, bodyText: error instanceof Error ? error.message : String(error), readback: null, approval: null, errorCode: 'NETWORK', errorReason: '', errorMessage: '' })
    } finally {
      setBusyKey('')
    }
  }

  const createTeam = async (): Promise<void> => {
    const built = buildSettingsTeamCreateBody({ code: teamCode, name: teamName, departmentId: teamDepartmentId })
    if (!built.ok) {
      setSettingsNote(`${built.reasonCode}：${built.reasonText}`)
      return
    }
    setSettingsBusy(true)
    setSettingsNote('')
    try {
      const res = await requestJson(CONFIG_PATH, { sessionId: props.sessionId, method: 'POST', body: built.body })
      const envelope = parseActionEnvelope(res.text)
      const error = pickError(res)
      setSettingsOutcome({
        key: 'recruiting_settings_write',
        ok: res.ok,
        status: res.status,
        bodyText: res.text,
        readback: envelope?.readback ?? null,
        approval: envelope === null ? null : { result: envelope.approval.result },
        errorCode: error.code,
        errorReason: error.reason,
        errorMessage: error.message,
      })
      if (res.ok) await loadOverview()
    } catch (error: unknown) {
      setSettingsOutcome({ key: 'recruiting_settings_write', ok: false, status: 0, bodyText: error instanceof Error ? error.message : String(error), readback: null, approval: null, errorCode: 'NETWORK', errorReason: '', errorMessage: '' })
    } finally {
      setSettingsBusy(false)
    }
  }

  /**
   * 按「岗位创建回执」批准一个 rubric 版本。
   *
   * 为什么需要这条入口（精确缺口，不假写）：approval 表在本 lane 没有只读投影，UI 无法列出
   * 真实 PENDING approval 行（见 §pending-approvals-source）；但批准动作本身是真实 Host Action。
   * 因此审批人可从 HR 的岗位创建 readback 里拿到 `job_id` + `versions.rubric_version_id`，
   * 在这里核对后交给服务端校验（hash/状态/归属全由服务端判），成功写 approval 行 + 移动指针。
   */
  const approveManualRubric = async (): Promise<void> => {
    const built = buildRubricApproveBody({ jobId: manualJobId.trim(), rubricVersionId: manualRubricId.trim() })
    if (!built.ok) {
      setManualNote(`${built.reasonCode}：${built.reasonText}`)
      return
    }
    setManualBusy(true)
    setManualNote('')
    try {
      const res = await requestJson(RUBRIC_APPROVE_PATH, { sessionId: props.sessionId, method: 'POST', body: built.body })
      const envelope = parseActionEnvelope(res.text)
      const error = pickError(res)
      setManualOutcome({
        key: 'manual',
        ok: res.ok,
        status: res.status,
        bodyText: res.text,
        readback: envelope?.readback ?? null,
        approval: envelope === null ? null : { result: envelope.approval.result },
        errorCode: error.code,
        errorReason: error.reason,
        errorMessage: error.message,
      })
      if (res.ok) await loadOverview()
    } catch (error: unknown) {
      setManualOutcome({ key: 'manual', ok: false, status: 0, bodyText: error instanceof Error ? error.message : String(error), readback: null, approval: null, errorCode: 'NETWORK', errorReason: '', errorMessage: '' })
    } finally {
      setManualBusy(false)
    }
  }

  const unauthorized = outcome !== null && !outcome.ok && (outcome.errorCode === 'FORBIDDEN' && outcome.errorReason === 'ACTOR_NOT_AUTHORIZED')

  return (
    <div data-testid="role-view-approvals" data-alias={props.alias ?? ''} style={{ padding: 20, color: COLORS.text, fontSize: 13 }}>
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>审批工作台 · 待审批事项与招聘设置</h2>
        <p style={{ margin: '6px 0 0', color: COLORS.sub }}>
          当前身份：<b>{props.alias ?? '未绑定'}</b>。批准 = 人对 rubric 版本的批准（Host Action allow-once），
          成功只认服务端信封 readback（写事务后独立读回）+ 重新 GET。
        </p>
      </header>

      {!canWrite ? (
        <div data-testid="approval-write-blocked" style={{ background: COLORS.amberBg, border: '1px solid #f3d9a4', color: COLORS.amber, borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
          当前 alias 不在 Host Action 写授权集合（服务端只授权 recruiter）：点击批准/保存会被 403 ACTOR_NOT_AUTHORIZED 拒绝且零写入。
          <button type="button" data-testid="switch-to-recruiter" onClick={() => props.onSwitchAlias('recruiter')} style={{ marginLeft: 8, border: `1px solid ${COLORS.border}`, background: '#fff', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>
            切换为 Recruiter 身份执行（写库作者 = 0103）
          </button>
        </div>
      ) : null}

      {loadError !== '' ? <p data-testid="approval-load-error" style={{ color: COLORS.red }}>读取失败：{loadError}</p> : null}
      {loading ? <p style={{ color: COLORS.sub }}>读取服务端投影…</p> : null}

      <Section
        title="待审批事项（Rubric 批准）"
        testid="pending-approvals"
        sub={`共 ${String(rows.length)} 项`}
      >
        <p data-testid="pending-approvals-source" style={{ margin: '0 0 8px', color: COLORS.sub, fontSize: 12 }}>
          来源：GET {RECRUITING_OVERVIEW_PATH} 的岗位投影（jobs[].rubric：rubric_version_id 非空且 approved!==true）。
          <b>approval 表在本 lane 没有只读投影</b>（src/http/** 禁改），因此列表不是直读 approval 表；approval 行的确认事实以 Host Action readback + 独立 psql 读回为准。
        </p>
        {rows.length === 0 ? (
          <p style={{ color: COLORS.sub }}>没有待批准 Rubric（服务端投影未给出）。</p>
        ) : (
          rows.slice(0, 20).map((row) => (
            <div key={row.jobId} data-testid={`pending-approval-${row.jobId}`} style={{ borderTop: `1px solid ${COLORS.border}`, padding: '8px 0' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <b>{row.jobTitle}</b>
                <span style={{ color: COLORS.sub }}>{row.jobStatus}</span>
                <code style={{ fontSize: 11, color: COLORS.sub }}>job {row.jobId}</code>
                <code style={{ fontSize: 11, color: COLORS.sub }}>rubric v{String(row.versionNo)} · {row.rubricVersionId}</code>
                <button
                  type="button"
                  data-testid={`approve-${row.jobId}`}
                  disabled={busyKey === row.jobId}
                  onClick={() => void approveRubric(row)}
                  style={{ border: `1px solid ${COLORS.border}`, background: COLORS.blue, color: '#fff', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}
                >
                  {busyKey === row.jobId ? '提交中…' : '批准 Rubric'}
                </button>
                <button
                  type="button"
                  data-testid={`reject-${row.jobId}`}
                  disabled
                  title="Host Action 没有 rubric 拒绝端点；拒绝路径零写入"
                  style={{ border: `1px solid ${COLORS.border}`, background: '#f1f5f9', color: COLORS.sub, borderRadius: 8, padding: '4px 10px', cursor: 'not-allowed', fontSize: 12 }}
                >
                  拒绝
                </button>
                <span data-testid={`reject-${row.jobId}-reason`} style={{ color: COLORS.sub, fontSize: 11 }}>
                  拒绝入口 disabled：Host Action 契约只有 job/rubric-approve（批准），没有拒绝端点（work/d5/actions/CONTRACT.md §4.1）；拒绝路径零写入。
                </span>
              </div>
            </div>
          ))
        )}
        {outcome !== null && outcome.key !== '' && outcome.key !== 'recruiting_settings_write' ? <ReadbackBlock outcome={outcome} testid="approval-readback" /> : null}
        {unauthorized ? (
          <p data-testid="approval-action-error" style={{ color: COLORS.amber, fontSize: 12 }}>
            服务端已 fail-closed 拒绝（无写库）。如需执行，请点上方「切换为 Recruiter 身份执行」。
          </p>
        ) : null}
      </Section>

      <Section
        title="待批准 Rubric（岗位创建回执核对）"
        testid="approval-manual-card"
        sub="精确缺口兜底：approval 表无只读投影，真实 PENDING approval 行无法被列出；审批人从 HR 的岗位创建 readback 拿到 job_id + versions.rubric_version_id，核对后批准（服务端校验归属/hash/状态，成功写 approval 行 + 移动 job.current_rubric_version_id）。"
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input data-testid="approval-manual-job-id" aria-label="岗位 id" placeholder="job_id（UUID，来自创建回执）" value={manualJobId} onChange={(event) => setManualJobId(event.target.value)} disabled={manualBusy} style={{ fontSize: 12, padding: '5px 8px', width: 330 }} />
          <input data-testid="approval-manual-rubric-id" aria-label="Rubric 版本 id" placeholder="rubric_version_id（UUID，来自创建回执）" value={manualRubricId} onChange={(event) => setManualRubricId(event.target.value)} disabled={manualBusy} style={{ fontSize: 12, padding: '5px 8px', width: 330 }} />
          <button
            type="button"
            data-testid="approval-manual-approve"
            disabled={manualBusy}
            onClick={() => void approveManualRubric()}
            style={{ border: `1px solid ${COLORS.border}`, background: COLORS.blue, color: '#fff', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}
          >
            {manualBusy ? '提交中…' : '批准该 Rubric 版本'}
          </button>
        </div>
        {manualNote !== '' ? <p data-testid="approval-manual-note" style={{ color: COLORS.amber, fontSize: 12 }}>{manualNote}</p> : null}
        {manualOutcome !== null ? <ReadbackBlock outcome={manualOutcome} testid="approval-manual-readback" /> : null}
        {manualOutcome !== null && !manualOutcome.ok && manualOutcome.errorCode === 'FORBIDDEN' && manualOutcome.errorReason === 'ACTOR_NOT_AUTHORIZED' ? (
          <p data-testid="approval-manual-error" style={{ color: COLORS.amber, fontSize: 12 }}>
            当前 alias 无写授权（服务端 fail-closed、零写入）：请先点上方「切换为 Recruiter 身份执行」再重试。
          </p>
        ) : null}
      </Section>

      <Section
        title="招聘设置（企业管理员职责 · 新建招聘团队）"
        testid="settings-write-card"
        sub="写入口 = POST /recruitment/api/action/config（body.entity=team, operation=create）；成功只认 readback + 重新 GET。"
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input data-testid="settings-team-code" aria-label="团队 code" placeholder="code（如 D5ROLES_T1）" value={teamCode} onChange={(event) => setTeamCode(event.target.value)} disabled={settingsBusy} style={{ fontSize: 12, padding: '5px 8px', width: 190 }} />
          <input data-testid="settings-team-name" aria-label="团队名称" placeholder="名称（1..200 字）" value={teamName} onChange={(event) => setTeamName(event.target.value)} disabled={settingsBusy} style={{ fontSize: 12, padding: '5px 8px', width: 240 }} />
          <select data-testid="settings-team-department" aria-label="所属部门" value={teamDepartmentId} onChange={(event) => setTeamDepartmentId(event.target.value)} disabled={settingsBusy} style={{ fontSize: 12, padding: '5px 8px' }}>
            <option value="">（请选择部门）</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>{department.name}（{department.id.slice(-8)}）</option>
            ))}
          </select>
          <button
            type="button"
            data-testid="settings-team-submit"
            disabled={settingsBusy}
            onClick={() => void createTeam()}
            style={{ border: `1px solid ${COLORS.border}`, background: COLORS.blue, color: '#fff', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}
          >
            {settingsBusy ? '保存中…' : '保存招聘设置（新建团队）'}
          </button>
        </div>
        {settingsNote !== '' ? <p style={{ color: COLORS.amber, fontSize: 12 }}>{settingsNote}</p> : null}
        {settingsOutcome !== null ? <ReadbackBlock outcome={settingsOutcome} testid="settings-readback" /> : null}
      </Section>
    </div>
  )
}
