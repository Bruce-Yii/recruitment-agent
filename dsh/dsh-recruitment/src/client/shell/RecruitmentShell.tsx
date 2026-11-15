// D5 产品外壳：按 Demo Actor 角色显示默认工作视图 + Human Attention 唯一入口。
//
// 口径（2026-11-15 P0-4，`work/d5/roles/CONTRACT.md` §1/§4.3、Notion 02 §04）：
//   * 5 个受控 Demo Actor alias（recruiter / hiring_manager / approver / interviewer_a / interviewer_b）；
//   * **默认视图由角色决定**：HR → recruiting；招聘负责人 → hiring；审批人 → approvals；
//     面试官 → interviewer；顶部只渲染该角色被授权看到的视图 tab（未授权视图不渲染）；
//   * 视图矩阵是**展示口径**，真实授权在服务端 Host Action（`src/http/actions.ts` 只授权 recruiter）；
//     非授权 alias 的写入口展示精确原因，由人**显式**切换为 Recruiter 身份，不静默换身份；
//   * Recruiter / Interviewer 的既有视图组件与 props 保持不变（现有行为不回归）。
//
// 约束：客户端不直连数据库；alias 只传受控枚举，不传 actor UUID；session id 只来自 DSH 的 localStorage，
// 缺失/未绑定一律显示 fail-closed 提示，不静默退回 HR 身份。

import { useEffect, useState } from 'react'
import { RecruitingWorkspace } from '../recruiting/RecruitingWorkspace.tsx'
import { InterviewerWorkspace } from '../interviewer/InterviewerWorkspace.tsx'
import { ApproverView } from './ApproverView.tsx'
import { HiringManagerView } from './HiringManagerView.tsx'
import {
  DEMO_ACTOR_OPTIONS,
  allowedViewsFor,
  defaultViewFor,
  isDemoActorAliasValue,
  profileForAlias,
  resolveViewForAlias,
  viewLabel,
  writeBlockedReasonFor,
  type DemoActorAlias,
  type WorkViewKey,
} from './role-views.ts'

interface AttentionItem {
  readonly id?: string
  readonly stage_code?: string
  readonly reason?: string
  readonly required_action?: string
}

interface AttentionOverview {
  readonly actor?: { readonly display_name?: string; readonly actor_id?: string }
  readonly labels?: Readonly<Record<string, string>>
  readonly counts?: Readonly<Record<string, number>>
  readonly lists?: Readonly<Record<string, readonly AttentionItem[]>>
  readonly unassigned?: {
    readonly note?: string
    readonly pending_decisions?: readonly AttentionItem[]
    readonly pending_reviews?: readonly AttentionItem[]
    readonly waiting_human_tasks?: readonly AttentionItem[]
    readonly connector_incidents?: readonly AttentionItem[]
  }
}

interface ActorBinding {
  readonly session_id: string
  readonly alias: string
  readonly actor_id: string
  readonly display_name?: string
  readonly roles?: readonly string[]
}

/** 从 DSH 的 localStorage 取当前 session id（Gate 0 实测键/形状）。 */
function readSessionId(): string | null {
  try {
    const raw = localStorage.getItem('dsh.sessions.current')
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { sessionId?: unknown }
    return typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : null
  } catch {
    return null
  }
}

/** 受控 alias 选择：只 PUT alias；session id 走受控 header，不传 actor UUID。 */
async function putBinding(sessionId: string, alias: DemoActorAlias): Promise<{ ok: boolean; body: string }> {
  const res = await fetch('/recruitment/api/actor', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-dsh-session': sessionId, 'x-recruitment-request': '1' },
    body: JSON.stringify({ alias }),
  })
  return { ok: res.ok, body: await res.text() }
}

async function getBinding(sessionId: string): Promise<ActorBinding | null> {
  const res = await fetch('/recruitment/api/actor', {
    credentials: 'same-origin',
    headers: { 'x-dsh-session': sessionId, 'x-recruitment-request': '1' },
  })
  if (!res.ok) return null
  const body = (await res.json()) as Partial<ActorBinding>
  if (typeof body.alias !== 'string' || typeof body.actor_id !== 'string') return null
  return body as ActorBinding
}

const COLORS = {
  bg: '#f4f6f9',
  card: '#ffffff',
  border: '#e3e8ef',
  text: '#16233a',
  sub: '#64748b',
  blue: '#2f6feb',
  blueBg: '#eef4ff',
  amber: '#92400e',
  amberBg: '#fff7e6',
} as const

/** 顶部按钮（视图切换 / Human Attention）。 */
function TabButton(props: { active: boolean; label: string; testid: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid={props.testid}
      onClick={props.onClick}
      style={{
        border: `1px solid ${props.active ? '#c7d8f2' : COLORS.border}`,
        background: props.active ? COLORS.blueBg : '#fff',
        color: props.active ? COLORS.blue : COLORS.sub,
        fontWeight: props.active ? 700 : 500,
        borderRadius: 999,
        padding: '6px 13px',
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      {props.label}
    </button>
  )
}

/** 视图渲染（只渲染当前 alias 被授权看到的视图；未授权视图不进入 DOM）。 */
function renderView(props: {
  view: WorkViewKey
  sessionId: string | null
  alias: string | null
  onSwitchAlias: (alias: 'recruiter') => void
}): JSX.Element {
  if (props.view === 'recruiting') {
    return <RecruitingWorkspace sessionId={props.sessionId ?? ''} alias={'recruiter'} />
  }
  if (props.view === 'interviewer') {
    return <InterviewerWorkspace sessionId={props.sessionId} alias={props.alias} />
  }
  if (props.view === 'hiring') {
    return <HiringManagerView sessionId={props.sessionId} alias={props.alias} onSwitchAlias={props.onSwitchAlias} />
  }
  return <ApproverView sessionId={props.sessionId} alias={props.alias} onSwitchAlias={props.onSwitchAlias} />
}

/**
 * 产品外壳。没有渠道注入 props：session id 从 DSH localStorage 取，alias 由人选择后 PUT 到服务端。
 * @returns 角色默认视图 + 视图切换（仅授权视图）+ Human Attention。
 */
export function RecruitmentShell(): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [alias, setAlias] = useState<string | null>(null)
  const [binding, setBinding] = useState<ActorBinding | null>(null)
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<WorkViewKey | null>(null)
  const [attentionOpen, setAttentionOpen] = useState(false)
  const [attention, setAttention] = useState<null | { error?: string; data?: AttentionOverview }>(null)

  const profile = profileForAlias(alias)
  const allowedViews = allowedViewsFor(alias)
  const canWrite = profile?.canExecuteWriteActions === true

  const openAttention = (): void => {
    setAttentionOpen(true)
    setAttention({ data: undefined, error: undefined })
    void fetch('/recruitment/api/overview', {
      credentials: 'same-origin',
      headers: { 'x-recruitment-request': '1' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
        return (await res.json()) as AttentionOverview
      })
      .then((data) => setAttention({ data }))
      .catch((error: unknown) => setAttention({ error: error instanceof Error ? error.message : String(error) }))
  }

  useEffect(() => {
    const sid = readSessionId()
    setSessionId(sid)
    if (sid === null) {
      setNotice('未取得 DSH Session（localStorage 无 dsh.sessions.current）；写入将 fail-closed。')
      return
    }
    void getBinding(sid).then((found) => {
      if (found === null) {
        setNotice('Demo Actor 未绑定：请选择身份；未绑定前所有写操作 fail-closed。')
        return
      }
      setBinding(found)
      setAlias(found.alias)
      setView(defaultViewFor(found.alias))
    })
  }, [])

  const onSelectAlias = (next: DemoActorAlias): void => {
    setAlias(next)
    setView((current) => resolveViewForAlias(current, next))
    if (sessionId === null) {
      setNotice('未取得 DSH Session，无法绑定 Demo Actor。')
      return
    }
    void putBinding(sessionId, next).then((result) => {
      if (!result.ok) {
        setBinding(null)
        setNotice(`Demo Actor 绑定失败（${result.body.slice(0, 160)}）；未绑定前写入 fail-closed。`)
        return
      }
      setNotice('')
      void getBinding(sessionId).then((found) => {
        setBinding(found)
        if (found !== null) {
          setAlias(found.alias)
          setView((current) => resolveViewForAlias(current, found.alias))
        }
      })
    })
  }

  const onSwitchAlias = (next: 'recruiter'): void => {
    onSelectAlias(next)
  }

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: COLORS.bg, color: COLORS.text }}>
      <div
        data-testid="shell-role"
        data-alias={alias ?? ''}
        data-role={profile?.role ?? ''}
        data-default-view={view ?? ''}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '10px 16px',
          background: COLORS.card,
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <strong style={{ fontSize: 14, marginRight: 4 }}>Recruitment</strong>
        <span style={{ color: COLORS.sub, fontSize: 11 }}>AGENT WORKSPACE</span>
        <span style={{ flex: 1 }} />
        {allowedViews.map((key) => (
          <TabButton
            key={key}
            testid={`view-tab-${key}`}
            active={view === key}
            label={viewLabel(key)}
            onClick={() => setView(key)}
          />
        ))}
        <button
          type="button"
          onClick={openAttention}
          style={{ border: `1px solid ${COLORS.border}`, background: '#fff', borderRadius: 999, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: COLORS.sub }}
        >
          Human Attention
        </button>
        <label style={{ fontSize: 11, color: COLORS.sub, display: 'flex', alignItems: 'center', gap: 6 }}>
          Demo Actor
          <select
            aria-label="选择 Demo Actor"
            value={alias ?? ''}
            onChange={(event) => onSelectAlias(event.target.value as DemoActorAlias)}
            style={{ fontSize: 12, padding: '5px 8px', border: `1px solid ${COLORS.border}`, borderRadius: 8, background: '#fff' }}
          >
            <option value="" disabled>
              未绑定
            </option>
            {DEMO_ACTOR_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {profile !== null ? (
          <span style={{ fontSize: 10, color: COLORS.sub }} data-testid="shell-role-label">
            {profile.roleLabel}
            {binding !== null ? ` · actor ${binding.actor_id.slice(-8)}` : ''}
          </span>
        ) : null}
        <span
          data-testid="shell-write-auth"
          data-can-write={canWrite ? 'true' : 'false'}
          style={{ fontSize: 10, color: canWrite ? '#15803d' : COLORS.amber, maxWidth: 460 }}
        >
          {canWrite ? 'Host Action 写授权：可执行（recruiter）' : writeBlockedReasonFor(alias, '写动作').slice(0, 180)}
        </span>
      </div>

      {notice !== '' ? (
        <div style={{ padding: '7px 16px', fontSize: 11, color: COLORS.amber, background: COLORS.amberBg, borderBottom: '1px solid #f3d9a4' }}>{notice}</div>
      ) : null}

      {attentionOpen ? (
        <div
          id="human-attention"
          role="dialog"
          aria-label="Human Attention"
          onClick={(event) => {
            if (event.target === event.currentTarget) setAttentionOpen(false)
          }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', zIndex: 50 }}
        >
          <aside
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 'min(540px, 94vw)',
              background: '#fff',
              boxShadow: '-12px 0 32px rgba(15,23,42,.18)',
              overflow: 'auto',
              padding: '16px 18px',
              color: COLORS.text,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 16 }}>Human Attention</strong>
              <span style={{ fontSize: 11, color: COLORS.sub }}>全局唯一人工处理入口（聚合既有业务记录）</span>
              <span style={{ flex: 1 }} />
              <button type="button" aria-label="关闭 Human Attention" onClick={() => setAttentionOpen(false)} style={{ border: 0, background: 'transparent', fontSize: 20, cursor: 'pointer' }}>
                ×
              </button>
            </div>
            {attention?.error !== undefined ? (
              <p style={{ color: '#b91c1c', fontSize: 12 }}>读取失败：{attention.error}</p>
            ) : attention?.data === undefined ? (
              <p style={{ color: COLORS.sub, fontSize: 12 }}>读取中…</p>
            ) : (
              <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                <p style={{ color: COLORS.sub }}>
                  actor：{attention.data.actor?.display_name ?? '未知'} · 标签：{attention.data.labels?.provenance ?? '?'} / {attention.data.labels?.trigger ?? '?'} / {attention.data.labels?.connection ?? '?'}
                </p>
                {([
                  ['pending_decisions', '待决策'],
                  ['my_interviews', '我的面试'],
                  ['overdue_scorecards', '逾期/缺面评'],
                  ['pending_reviews', '待复核材料'],
                  ['waiting_human_tasks', '等待人工的任务'],
                  ['connector_incidents', '连接器异常'],
                ] as const).map(([key, label]) => {
                  const items = attention.data?.lists?.[key] ?? []
                  return (
                    <section key={key} style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 700 }}>{label}（{items.length}）</div>
                      {items.length === 0 ? (
                        <div style={{ color: COLORS.sub }}>没有</div>
                      ) : (
                        items.slice(0, 12).map((item, index) => (
                          <div key={`${key}-${item.id ?? index}`} style={{ borderTop: `1px solid ${COLORS.border}`, padding: '4px 0' }}>
                            <code style={{ fontSize: 10 }}>{item.id ?? '?'}</code> · {item.stage_code ?? ''} {item.required_action ?? ''}
                            <div style={{ color: COLORS.sub }}>{item.reason ?? ''}</div>
                          </div>
                        ))
                      )}
                    </section>
                  )
                })}
                <section style={{ marginTop: 14 }}>
                  <div style={{ fontWeight: 700 }}>未分配（全租户共享）</div>
                  <div style={{ color: COLORS.sub }}>{attention.data.unassigned?.note ?? ''}</div>
                  {(['pending_decisions', 'pending_reviews', 'waiting_human_tasks', 'connector_incidents'] as const).map((key) => {
                    const items = attention.data?.unassigned?.[key] ?? []
                    return (
                      <div key={`u-${key}`} style={{ marginTop: 6 }}>
                        <b>{key}</b>（{items.length}）
                        {items.slice(0, 8).map((item, index) => (
                          <div key={`u-${key}-${item.id ?? index}`} style={{ color: COLORS.sub }}>
                            <code style={{ fontSize: 10 }}>{item.id ?? '?'}</code> {item.reason ?? ''}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </section>
              </div>
            )}
          </aside>
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }} data-testid="shell-view-container" data-view={view ?? ''}>
        {view === null ? (
          <div data-testid="shell-unbound" style={{ padding: 28, color: COLORS.sub, fontSize: 13, lineHeight: 1.8 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}>未绑定 Demo Actor</div>
            <p>请先在顶部选择受控 Demo Actor（Recruiter / 招聘负责人 / 审批人 / Interviewer A / Interviewer B）。</p>
            <p>未绑定前所有写操作 fail-closed，界面不静默退回任何默认身份。</p>
          </div>
        ) : (
          renderView({ view, sessionId, alias, onSwitchAlias })
        )}
      </div>
    </div>
  )
}

/** 顶层别名（供测试/文档检索；避免误用未导出的内部类型）。 */
export type { DemoActorAlias }
