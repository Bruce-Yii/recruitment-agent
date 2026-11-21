// D5 产品外壳：两个工作视图（Recruiting / Interviewer）+ 顶部 Demo Actor 选择 + Human Attention 唯一入口。
//
// W0 独占本文件与 `index.tsx` 注册；W2/W3 只提供各自 workspace 组件（后续在此 import）。
// 当前 schema 冻结前，Recruiting 先复用已验证的真实数据面板 `Workbench`（读 /recruitment/api/overview），
// Interviewer 先给只读占位；W2/W3 落地后由 W0 替换为 `RecruitingWorkspace` / `InterviewerWorkspace`。
//
// 约束：客户端不直连数据库；alias 只传受控枚举，不传 actor UUID；session id 只来自 DSH 的 localStorage，
// 缺失/未绑定一律显示 fail-closed 提示，不静默退回 HR 身份。

import { useEffect, useState } from 'react'
import { CanvasRoute, type CanvasRouteTarget } from '../canvas/CanvasRoute.tsx'
import { RecruitingWorkspace } from '../recruiting/RecruitingWorkspace.tsx'
import { InterviewerWorkspace } from '../interviewer/InterviewerWorkspace.tsx'

export type DemoActorAlias = 'recruiter' | 'interviewer_a' | 'interviewer_b'

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
  readonly alias: DemoActorAlias
  readonly actor_id: string
  readonly display_name?: string
}

const ALIAS_OPTIONS: ReadonlyArray<{ value: DemoActorAlias; label: string }> = [
  { value: 'recruiter', label: 'Recruiter' },
  { value: 'interviewer_a', label: 'Interviewer A' },
  { value: 'interviewer_b', label: 'Interviewer B' },
]

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
} as const

/** 顶部按钮（视图切换 / Human Attention）。 */
function TabButton(props: { active: boolean; label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
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

/** Interviewer 视图占位：W3 落地后由 W0 替换为 InterviewerWorkspace（只读占位不伪造业务数据）。 */
function InterviewerPlaceholder(props: { alias: DemoActorAlias | null; sessionId: string | null }): JSX.Element {
  return (
    <div style={{ padding: 28, color: COLORS.sub, fontSize: 13, lineHeight: 1.8 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}>Interviewer Workspace</div>
      <p>该视图由 W3 实现（我的面试 / 简报 / Rubric / 授权材料 / 本人 Scorecard）。</p>
      <p>
        当前身份：<b>{props.alias ?? '未绑定'}</b>
        <br />
        会话：<code>{props.sessionId ? `${props.sessionId.slice(0, 8)}…` : '未取得'}</code>
      </p>
    </div>
  )
}

/**
 * 产品外壳。没有渠道注入 props：session id 从 DSH localStorage 取，alias 由人选择后 PUT 到服务端。
 * @returns 两个工作视图 + 顶部身份/注意力入口。
 */
/** 画布入口：`#/canvas/candidate/<application_id>` 或 `#/canvas/job/<job_id>`（链接直达，不新增按钮）。 */
function readCanvasRoute(): CanvasRouteTarget {
  if (typeof window === 'undefined') return { kind: 'empty' }
  const match = /^#\/canvas\/(candidate|job)\/([0-9a-fA-F-]{8,})$/.exec(window.location.hash)
  if (match === null) return { kind: 'empty' }
  return match[1] === 'candidate'
    ? { kind: 'candidate', applicationId: match[2]! }
    : { kind: 'job', jobId: match[2]! }
}

export function RecruitmentShell(): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [alias, setAlias] = useState<DemoActorAlias | null>(null)
  const [binding, setBinding] = useState<ActorBinding | null>(null)
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<'recruiting' | 'interviewer'>('recruiting')
  const [attentionOpen, setAttentionOpen] = useState(false)
  const [attention, setAttention] = useState<null | { error?: string; data?: AttentionOverview }>(null)
  const [canvasRoute, setCanvasRoute] = useState<CanvasRouteTarget>(readCanvasRoute)

  // 监听 hash 变化：链接直达画布，不刷新页面。
  useEffect(() => {
    const onHashChange = (): void => setCanvasRoute(readCanvasRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // 画布链接直达：只在 hash 命中 `#/canvas/...` 时接管，其余视图完全不变。
  if (canvasRoute.kind !== 'empty') {
    return (
      <CanvasRoute
        route={canvasRoute}
        onBack={() => {
          if (typeof window !== 'undefined') window.history.replaceState(null, '', '#')
          setCanvasRoute({ kind: 'empty' })
        }}
      />
    )
  }


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
      setNotice('还没有识别到你的登录身份；在此之前写操作都不会提交。')
      return
    }
    void getBinding(sid).then((found) => {
      if (found === null) {
        setNotice('还没有选择身份：请先选择身份；在此之前写操作都不会提交。')
        return
      }
      setBinding(found)
      setAlias(found.alias)
    })
  }, [])

  const onSelectAlias = (next: DemoActorAlias): void => {
    setAlias(next)
    if (sessionId === null) {
      setNotice('还没有识别到当前会话，无法绑定演示身份。')
      return
    }
    void putBinding(sessionId, next).then((result) => {
      if (!result.ok) {
        setBinding(null)
        setNotice(`身份绑定失败（${result.body.slice(0, 160)}）；绑定成功之前写操作不会提交。`)
        return
      }
      setNotice('')
      void getBinding(sessionId).then((found) => setBinding(found))
    })
  }

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: COLORS.bg, color: COLORS.text }}>
      <div
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
        <TabButton active={view === 'recruiting'} label="招聘工作台" onClick={() => setView('recruiting')} />
        <TabButton active={view === 'interviewer'} label="面试官工作台" onClick={() => setView('interviewer')} />
        <button
          type="button"
          onClick={openAttention}
          style={{ border: `1px solid ${COLORS.border}`, background: '#fff', borderRadius: 999, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: COLORS.sub }}
        >
          Human Attention
        </button>
        <label style={{ fontSize: 11, color: COLORS.sub, display: 'flex', alignItems: 'center', gap: 6 }}>
          演示身份
          <select
            aria-label="选择演示身份"
            value={alias ?? ''}
            onChange={(event) => onSelectAlias(event.target.value as DemoActorAlias)}
            style={{ fontSize: 12, padding: '5px 8px', border: `1px solid ${COLORS.border}`, borderRadius: 8, background: '#fff' }}
          >
            <option value="" disabled>
              未绑定
            </option>
            {ALIAS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {binding !== null ? (
          <span style={{ fontSize: 10, color: COLORS.sub }}>
            actor {binding.actor_id.slice(-8)} · {binding.display_name ?? ''}
          </span>
        ) : null}
      </div>

      {notice !== '' ? (
        <div style={{ padding: '7px 16px', fontSize: 11, color: '#92400e', background: '#fff7e6', borderBottom: '1px solid #f3d9a4' }}>{notice}</div>
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

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {view === 'recruiting'
          ? <RecruitingWorkspace sessionId={sessionId ?? ''} alias={alias ?? 'recruiter'} />
          : <InterviewerWorkspace sessionId={sessionId} alias={alias} />}
      </div>
    </div>
  )
}
