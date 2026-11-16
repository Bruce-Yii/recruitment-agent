// 岗位关闭确认弹窗（W2）：**人类闸门**——取消零请求，确认才发一次 `POST .../job-action/job/close`。
//
// 契约出处：
//   · `work/d5/joblife/CONTRACT.md` §3：UI 弹窗文案**逐字**（标题 / 正文 / 可选输入 / 主按钮 / 次按钮）；
//     点「取消」= 不发任何请求、零写入（前端不得先乐观改为已关闭）；
//     点主按钮才发 `POST /recruitment/api/job-action/job/close`，body `{job_id, confirm:true, reason?}`；
//   · `work/d5/w2b/INTERFACE.md` §2.6：`CloseJobDialog({ jobTitle, busy, error, onConfirm, onCancel })` +
//     `data-testid="close-job-dialog" / close-job-confirm / close-job-cancel / close-job-reason`，reason ≤500。
//
// 本组件**只**做展示与表单：不 fetch、不调 use-recruiting、不碰 localStorage / sessionStorage；
// 网络请求全部由 `RecruitingWorkspace` 的 `postJobClose`（A 的数据层）在确认后发起。

import { useState } from 'react'

/** 关闭原因长度上限（`work/d5/joblife/CONTRACT.md` §1：reason 可选，给了就必须 1..500）。 */
export const CLOSE_JOB_REASON_MAX = 500

/**
 * 弹窗文案（逐字取自 `work/d5/joblife/CONTRACT.md` §3；改文案必须先改合同）。
 *
 * 拼回完整文案的口径：
 *   `标题：${title}` / `正文：${bodyLines[0]}` / `      ${bodyLines[1..]}` /
 *   `可选输入：${reasonLabel}` / `主按钮：${confirmLabel}` / `次按钮：${cancelLabel}`。
 */
export const CLOSE_JOB_DIALOG_TEXT = {
  /** 标题。 */
  title: '关闭岗位并终止在途申请？',
  /** 正文（第一段接在「正文：」后；其余段落各占一行）。 */
  bodyLines: [
    '关闭后该岗位不再接收新申请，招聘流程停止。',
    '该岗位下所有进行中（ACTIVE / ON_HOLD）的申请将被终止（status=CLOSED），',
    '尚未开始的面试将被取消，与该岗位相关的未完成任务将被取消。',
    '历史记录保留；进行中/已面试的面试与已有评价不会被改写。',
    '此操作不可自动恢复，且必须由人工确认。',
  ],
  /** 可选输入说明（UI 前缀「可选输入：」）。 */
  reasonLabel: '关闭原因（选填，最多 500 字）',
  /** 主按钮。 */
  confirmLabel: '确认关闭并终止在途申请',
  /** 次按钮。 */
  cancelLabel: '取消',
} as const

/** 弹窗入参（逐字遵守 INTERFACE §2.6；`error` 里放服务端原文，含 rawBody）。 */
export interface CloseJobDialogProps {
  /** 目标岗位名称（弹窗里显示"要关哪个岗位"，避免误关）。 */
  readonly jobTitle: string
  /** 正在提交（确认后等待响应）：确认按钮禁用并显示"提交中…"。 */
  readonly busy: boolean
  /** 服务端原文错误（空串 = 无错误）；成功后由父组件关闭弹窗。 */
  readonly error: string
  /** 人点了主按钮：把（裁剪后的）原因交给父组件发请求。 */
  readonly onConfirm: (reason: string) => void
  /** 人点了「取消」：**只**关闭弹窗，零请求。 */
  readonly onCancel: () => void
}

/**
 * 岗位关闭确认弹窗。
 * @param props - 见 {@link CloseJobDialogProps}。
 * @returns 弹窗 JSX（取消只调 `onCancel`，组件内没有任何网络调用）。
 */
export function CloseJobDialog({ jobTitle, busy, error, onConfirm, onCancel }: CloseJobDialogProps) {
  const [reason, setReason] = useState('')
  return (
    <div className="rcw-modalscrim" data-testid="close-job-scrim">
      <div
        className="rcw-modal"
        role="dialog"
        aria-modal="true"
        aria-label={CLOSE_JOB_DIALOG_TEXT.title}
        data-testid="close-job-dialog"
        data-job-title={jobTitle}
        data-busy={busy ? 'true' : 'false'}
      >
        <h2 data-testid="close-job-title">{CLOSE_JOB_DIALOG_TEXT.title}</h2>
        <p className="rcw-modal-job" data-testid="close-job-job">
          目标岗位：{jobTitle !== '' ? jobTitle : '（服务端未提供岗位名称）'}
        </p>

        <div className="rcw-modal-body" data-testid="close-job-body">
          {CLOSE_JOB_DIALOG_TEXT.bodyLines.map((line, index) => (
            <p key={`close-job-body-${String(index)}`} data-testid={`close-job-body-${String(index)}`}>
              {line}
            </p>
          ))}
        </div>

        <label className="rcw-modalfield">
          <span data-testid="close-job-reason-label">可选输入：{CLOSE_JOB_DIALOG_TEXT.reasonLabel}</span>
          <textarea
            className="rcw-textarea"
            data-testid="close-job-reason"
            rows={3}
            maxLength={CLOSE_JOB_REASON_MAX}
            value={reason}
            disabled={busy}
            placeholder="选填；该原因只进内部审计事件，不写任何业务列"
            onChange={(event) => {
              // 双重上限：maxLength 管浏览器粘贴，slice 管程序化赋值，保证上送 ≤500。
              setReason(event.target.value.slice(0, CLOSE_JOB_REASON_MAX))
            }}
          />
          <span className="rcw-dim rcw-tiny" data-testid="close-job-reason-count">
            已输入 {reason.length} / {CLOSE_JOB_REASON_MAX} 字
          </span>
        </label>

        {error !== '' ? (
          <pre className="rcw-modalerror" data-testid="close-job-error">
            {error}
          </pre>
        ) : null}

        <div className="rcw-inlineactions">
          <button
            type="button"
            className="rcw-btn rcw-btn-negative"
            data-testid="close-job-confirm"
            disabled={busy}
            onClick={() => {
              onConfirm(reason.trim())
            }}
          >
            {busy ? '提交中…' : CLOSE_JOB_DIALOG_TEXT.confirmLabel}
          </button>
          <button
            type="button"
            className="rcw-btn rcw-btn-soft"
            data-testid="close-job-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            {CLOSE_JOB_DIALOG_TEXT.cancelLabel}
          </button>
        </div>

        <p className="rcw-muted rcw-tiny" style={{ marginTop: 10 }}>
          点「{CLOSE_JOB_DIALOG_TEXT.cancelLabel}」不发任何请求、零写入；
          点「{CLOSE_JOB_DIALOG_TEXT.confirmLabel}」才会真正提交一次关闭请求（需要你确认，会留下记录）。
        </p>
      </div>
    </div>
  )
}

export default CloseJobDialog
