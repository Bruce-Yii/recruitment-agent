// 招聘工作区（W2）无状态原语：Card / Chip / Metric / ActionButton / Disclosure / 结论区 …
//
// 这些原语**只负责渲染**，不取数、不写状态、不碰 localStorage。
// DOM 证据钩子（浏览器证据会读这些稳定属性）：
//   · 根节点 `data-testid="recruiting-workspace"` + `data-view="recruiting"`
//   · 结论区 `data-testid="next-step"` + `data-scope="job|application"` + `data-code="<code>"`
//   · 写按钮 `data-testid="action-<key>"` + `data-available="true|false"` + `data-pending="<code>"`

import type { CSSProperties, ReactNode } from 'react'
import type { ChipTone } from './format.ts'
import type { ActionView, NextStepView, ThreeDimView } from './view-model.ts'
import { chipClass } from './styles.ts'

/** 白纸卡（V5.6.1 `.paper`）。 */
export function Card({
  children,
  className = '',
  style,
  testid,
}: {
  readonly children: ReactNode
  readonly className?: string
  readonly style?: CSSProperties
  readonly testid?: string
}) {
  return (
    <section className={`rcw-paper ${className}`.trim()} style={style} {...(testid !== undefined ? { 'data-testid': testid } : {})}>
      {children}
    </section>
  )
}

/** 状态 chip。 */
export function Chip({
  tone = 'gray',
  children,
  title,
  testid,
}: {
  readonly tone?: ChipTone
  readonly children: ReactNode
  readonly title?: string
  readonly testid?: string
}) {
  return (
    <span className={chipClass(tone)} {...(title !== undefined ? { title } : {})} {...(testid !== undefined ? { 'data-testid': testid } : {})}>
      {children}
    </span>
  )
}

/** 三维标签徽标（LIVE / FIXTURE / EVENT / MANUAL / CONNECTED …）。 */
export function ThreeDimBadges({ labels, testid }: { readonly labels: ThreeDimView; readonly testid?: string }) {
  return (
    <span className="rcw-chiprow" {...(testid !== undefined ? { 'data-testid': testid } : {})}>
      {labels.rows.map((row) => (
        <span
          key={row.key}
          className={`rcw-badge rcw-badge-${row.value.toLowerCase()}`}
          title={`${row.label}：${row.value !== '' ? row.value : '（服务端未提供）'}`}
          data-dim={row.key}
          data-value={row.value}
        >
          {row.label} {row.value !== '' ? row.value : '—'}
        </span>
      ))}
    </span>
  )
}

/** 区块标题（V5.6.1 `.sectionhead`）。 */
export function SectionHead({
  title,
  note,
  right,
}: {
  readonly title: string
  readonly note?: string
  readonly right?: ReactNode
}) {
  return (
    <div className="rcw-sectionhead">
      <h2>
        {title}
        {note !== undefined && note !== '' ? <small style={{ marginLeft: 8 }}>{note}</small> : null}
      </h2>
      {right}
    </div>
  )
}

/** 指标块（数字 + 标签；数字非负整数，标签写清口径）。 */
export function Metric({ value, label, testid }: { readonly value: number | string; readonly label: string; readonly testid?: string }) {
  return (
    <div className="rcw-metric" {...(testid !== undefined ? { 'data-testid': testid } : {})}>
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  )
}

/** 键值行（值缺失时显示"—"，不显示 undefined）。 */
export function KeyValue({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <div className="rcw-kv">
      <span className="rcw-k">{label}</span>
      <span className={`rcw-v ${mono ? 'rcw-mono' : ''}`.trim()}>{value !== '' ? value : '—'}</span>
    </div>
  )
}

/** 业务结论 + 下一步（**每视图唯一一份**；`data-testid="next-step"` 供浏览器证据读）。 */
export function NextStepPanel({
  step,
  scope,
  fallback = '暂无下一步',
  testid = 'next-step',
}: {
  readonly step: NextStepView
  readonly scope: 'job' | 'application'
  readonly fallback?: string
  readonly testid?: string
}) {
  return (
    <div
      className="rcw-nextstep"
      data-testid={testid}
      data-scope={scope}
      data-code={step.code}
      data-kind={step.kind}
      data-has-step={step.hasStep ? 'true' : 'false'}
    >
      <span className="rcw-cap">业务结论 · 下一步</span>
      <div className="rcw-nextstep-main">
        {step.kindLabel !== '' ? <Chip tone={step.tone}>{step.kindLabel}</Chip> : null}
        {/*
          O6：机器码是开发内部信息，不能作为 HR 主文案（D-135 ①）。
          `code` 只留在 `data-code`（根节点 + 隐藏钩子）与数据层；可见文案只用人话 label / fallback。
        */}
        <strong data-testid="next-step-label">{step.label !== '' ? step.label : fallback}</strong>
      </div>
      <div className="rcw-nextstep-meta">
        <span className="rcw-code" data-testid="next-step-code" data-code={step.code} hidden />
        {!step.hasStep ? <span>还没有下一步信息</span> : null}
      </div>
    </div>
  )
}

/** 写动作按钮：可用性**只**来自服务端 `actions[key]`；不可用 → disabled + pending 文案，点击不发请求。 */
export function ActionButton({
  action,
  onRun,
  pending,
  aliasBlocked = false,
  aliasNote,
}: {
  readonly action: ActionView
  readonly onRun: (action: ActionView) => void
  readonly pending: boolean
  readonly aliasBlocked?: boolean
  readonly aliasNote?: string
}) {
  const blockedByAlias = aliasBlocked && action.available
  const usable = action.available && !blockedByAlias
  // O6：disabled 原因只给 HR 能执行的人话；机器码留在 `data-pending`（结构化字段）与数据层。
  const note = blockedByAlias
    ? (aliasNote ?? '当前身份不能执行写操作，请切换到招聘方身份后再试')
    : action.reasonText !== ''
      ? action.reasonText
      : '这个操作暂时不可用'
  const title = usable ? '点击提交；成功后页面会重新读取服务端' : note
  return (
    <span className="rcw-actionwrap">
      <button
        type="button"
        className={`rcw-btn ${usable ? 'rcw-btn-blue' : ''}`.trim()}
        data-testid={`action-${action.key}`}
        data-action-key={action.key}
        data-available={usable ? 'true' : 'false'}
        data-seam={usable ? action.seam : ''}
        data-pending={action.available ? undefined : action.pending}
        data-alias-blocked={blockedByAlias ? 'true' : undefined}
        disabled={!usable || pending}
        title={title}
        onClick={() => {
          if (!usable) return
          onRun(action)
        }}
      >
        {pending ? '提交中…' : action.label}
      </button>
      {!usable ? (
        <span className="rcw-pending" data-testid={`pending-${action.key}`}>
          {note}
        </span>
      ) : null}
    </span>
  )
}

/** 默认收起的渐进展开区（`<details>`，服务端事实在里面）。 */
export function Disclosure({
  title,
  hint,
  testid,
  children,
}: {
  readonly title: string
  readonly hint?: string
  readonly testid?: string
  readonly children: ReactNode
}) {
  return (
    <details className="rcw-paper rcw-disclosure" {...(testid !== undefined ? { 'data-testid': testid } : {})}>
      <summary>
        {title}
        {hint !== undefined && hint !== '' ? <span className="rcw-dim" style={{ marginLeft: 8, fontWeight: 500 }}>{hint}</span> : null}
      </summary>
      <div className="rcw-disclosure-body">{children}</div>
    </details>
  )
}

/** 空态（明确写"没有…"，不把故障说成空台账）。 */
export function EmptyState({ children }: { readonly children: ReactNode }) {
  return <div className="rcw-empty">{children}</div>
}

/** 只读原文框（简历原文 / 描述 / 服务端错误体）。 */
export function SourceBox({ children, testid }: { readonly children: ReactNode; readonly testid?: string }) {
  return (
    <div className="rcw-sourcebox" {...(testid !== undefined ? { 'data-testid': testid } : {})}>
      {children}
    </div>
  )
}

/** 错误块：显示服务端 `{error:{code,reason_code,message}}` 原文，绝不伪装成"没有数据"。 */
export function ErrorAlert({
  title,
  message,
  rawBody,
  onRetry,
}: {
  readonly title: string
  readonly message: string
  readonly rawBody?: string
  readonly onRetry?: () => void
}) {
  return (
    <div className="rcw-alert" role="alert" data-testid="load-error">
      <strong>{title}</strong>
      <div style={{ marginTop: 6 }}>{message}</div>
      {rawBody !== undefined && rawBody !== '' ? (
        <pre data-testid="load-error-raw">{rawBody}</pre>
      ) : (
        <pre data-testid="load-error-raw">（服务端没有返回响应体）</pre>
      )}
      {onRetry !== undefined ? (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="rcw-btn rcw-btn-sm" data-testid="retry-load" onClick={onRetry}>
            重新读取
          </button>
        </div>
      ) : null}
    </div>
  )
}
