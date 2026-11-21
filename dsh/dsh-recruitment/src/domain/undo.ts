// 撤销域（自包含、纯逻辑）：预检 + 补偿计划。
//
// 定位：Owner 的 `src/http/batch-undo.ts` 调本模块的 `precheckUndo` / `planCompensation`，
// 再交给 undo-log DB 层（子代理 B）落补偿动作。本模块**不碰库、不写事件**。
//
// 补偿语义（不是删除）：
//   * DECISION —— 复用 `src/tools/decision-record.ts` 的既有 supersede 路径
//     （反向插一行 + 换指针 + 旧行 record_version+1）。既有事件由决策域自己写
//     `decision.record`，这里不另造事件名。
//   * SCHEDULE —— 复用 `src/tools/interview-schedule.ts` 的既有 `intent='CANCEL'`
//     路径（同一行改 CANCELLED；既有事件 `interview.cancelled` 由排期域写）。
//
// 身份纪律：顶层 args **绝不**带 `actor_id` / `tenant_id` 等保留键（决策/排期域一律拒收）。
// 嵌套的 `human_confirmation.confirmed_by_actor_id` 与 `basis_refs[SUPERSEDES].opened_by_actor_id`
// 是既有域的必填字段，值来自执行上下文（调用方传入的 actorId），不是新增身份入口。
import { createHash } from 'node:crypto'

export const UNDO_WINDOW_MS = 5 * 60 * 1000

/** 撤销目标类型（由 undo_log 行里的 action_type 决定）。 */
export type UndoTargetKind = 'DECISION' | 'SCHEDULE'

/** 撤销预检的输入：从 undo_log 读回的原始事实（B 提供读取函数）。 */
export interface UndoPrecheckInput {
  readonly tenant_id: string
  readonly actor_id: string       // 当前执行者（session→alias 解析得到），必须等于原操作 actor
  readonly action_id: string      // 上一次写操作返回的动作 id（UUID）
  readonly action_type: UndoTargetKind
  readonly occurred_at: Date | string   // 原操作发生时间
  readonly actor_id_of_action: string   // 原操作 actor
  readonly compensation_action_id: string | null  // 若已撤销则非 null（幂等）
  readonly superseded_by_action_id: string | null // 若该 action 已被后续动作影响则非 null
  readonly now_ms: number         // 服务端当前毫秒（可注入测试）
}

/** 预检结果：放行或拒绝（拒绝时 Owner 直接映射成 409/403，零写入）。 */
export type UndoPrecheck =
  | { readonly ok: true; readonly target: UndoTargetKind }
  | { readonly ok: false; readonly code: 'UNDO_WINDOW_EXPIRED' | 'UNDO_SUPERSEDED' | 'ALREADY_UNDONE' | 'ACTOR_MISMATCH'; readonly message: string; readonly detail?: Record<string, unknown> }

function reject(
  code: Exclude<UndoPrecheck, { ok: true }>['code'],
  message: string,
  detail?: Record<string, unknown>,
): UndoPrecheck {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail }
}

/**
 * 纯函数（不碰库）：时限 + 幂等 + 越权 + 后续影响 的四道判定。
 * 判定顺序固定：① ALREADY_UNDONE（compensation_action_id 非空 → 第二次撤销零写入）
 *              ② ACTOR_MISMATCH（当前 actor ≠ 原 actor）
 *              ③ UNDO_SUPERSEDED（superseded_by_action_id 非空）
 *              ④ UNDO_WINDOW_EXPIRED（now_ms - occurred_at > UNDO_WINDOW_MS；边界 = 恰好 5min 仍允许）
 * 时间用 Date.parse(String(occurred_at))；解析失败一律 UNDO_WINDOW_EXPIRED（fail-closed）。
 */
export function precheckUndo(input: UndoPrecheckInput): UndoPrecheck {
  // ① 幂等：已经撤销过 → 第二次撤销零写入（优先于时间/越权等一切判定）。
  if (input.compensation_action_id !== null && input.compensation_action_id !== '') {
    return reject('ALREADY_UNDONE', '该动作已撤销，重复撤销不产生写入', {
      action_id: input.action_id,
      compensation_action_id: input.compensation_action_id,
    })
  }

  // ② 越权：只有原操作 actor 本人能撤销。
  if (input.actor_id !== input.actor_id_of_action) {
    return reject('ACTOR_MISMATCH', '当前执行者不是原操作人，撤销被拒绝', {
      action_id: input.action_id,
      expected_actor_id: input.actor_id_of_action,
      actual_actor_id: input.actor_id,
    })
  }

  // ③ 后续影响：该动作已被后续动作影响 → 不可撤销。
  if (input.superseded_by_action_id !== null && input.superseded_by_action_id !== '') {
    return reject('UNDO_SUPERSEDED', '该动作已被后续动作影响，撤销被拒绝', {
      action_id: input.action_id,
      superseded_by_action_id: input.superseded_by_action_id,
    })
  }

  // ④ 时限：fail-closed。Date 对象 / ISO 字符串都走 Date.parse(String(...))。
  const occurredMs = Date.parse(String(input.occurred_at))
  if (!Number.isFinite(occurredMs)) {
    return reject('UNDO_WINDOW_EXPIRED', '原操作时间无法解析，撤销被拒绝（fail-closed）', {
      action_id: input.action_id,
      occurred_at: String(input.occurred_at),
    })
  }
  const elapsed = input.now_ms - occurredMs
  // 未来时间（elapsed < 0）一律 fail-closed；恰好 5min 放行，> 5min 拒绝。
  if (elapsed < 0 || elapsed > UNDO_WINDOW_MS) {
    return reject('UNDO_WINDOW_EXPIRED', '撤销窗口已过（5 分钟）或时间异常', {
      action_id: input.action_id,
      occurred_at: String(input.occurred_at),
      now_ms: input.now_ms,
      elapsed_ms: elapsed,
    })
  }

  return { ok: true, target: input.action_type }
}

/**
 * 把一次操作的领域事实收敛成"补偿计划"：仅决定走哪条既有域路径、需要哪些入参，不执行写。
 * 输入是 undo_log 行里记录的 target 摘要（只存引用/摘要，不存大段业务内容）。
 */
export interface UndoTargetRef {
  readonly application_id: string   // 决策目标申请
  readonly decision_id?: string     // 决策撤销：要 supersede 的那条 current 决策 id
  readonly decision_scope?: 'SCREENING' | 'STAGE' | 'FINAL'
  readonly decision_stage_code?: string
  readonly interview_id?: string    // 排期撤销：要 CANCEL 的面试 id
  readonly reason: string           // 原操作的 reason（撤销理由会带"撤销：<reason>"前缀）
  readonly confirmation_text: string // 人的原话（撤销确认，服务端算 sha256）
}

export type UndoPlan =
  | { readonly kind: 'DECISION'; readonly args: Record<string, unknown>; readonly domain: 'recordDecisionInTransaction'; readonly note: string }
  | { readonly kind: 'SCHEDULE'; readonly args: Record<string, unknown>; readonly domain: 'scheduleInTransaction'; readonly note: string }

const UNDO_REASON_PREFIX = '撤销：'

function undoReason(reason: string): string {
  return reason.startsWith(UNDO_REASON_PREFIX) ? reason : `${UNDO_REASON_PREFIX}${reason}`
}

/**
 * 由 target 摘要构造补偿计划（纯函数，不碰库）。DECISION → supersedes 入参；SCHEDULE → intent=CANCEL 入参。
 *
 * DECISION 分支返回**低层域 `recordDecisionInTransaction` 的直接入参**（高层
 * `createRecordHumanDecisionTool` 不支持 supersede）。`supersedes.expected_record_version`
 * 与本计划里的占位 `0` 必须由 Owner 从库读当前 decision 行后覆盖，否则域会抛
 * VERSION_CONFLICT。basis_refs 里带一条 `SUPERSEDES`，其 decision_id / reason /
 * opened_by_actor_id 与 supersedes 入参（及执行 actor）自洽，满足 DC-33。
 *
 * SCHEDULE 分支与 `parseScheduleArgs` 的 `intent=CANCEL` 兼容：CANCEL 必填 reason
 * （1..500，带撤销前缀）；`expected_record_version` 占位 0 同样必须由 Owner 覆盖。
 * 两条路径的顶层 args 都不含身份键（actor_id / tenant_id）；actor 由执行上下文提供。
 */
export function planCompensation(
  target: UndoTargetRef,
  kind: UndoTargetKind,
  actorId: string,
  nowIso: string,
): UndoPlan {
  const reason = undoReason(target.reason)

  if (kind === 'DECISION') {
    const decisionId = target.decision_id ?? ''
    const scope = target.decision_scope ?? 'SCREENING'
    const confirmationTextSha256 = createHash('sha256').update(target.confirmation_text, 'utf8').digest('hex')

    return {
      kind: 'DECISION',
      domain: 'recordDecisionInTransaction',
      args: {
        application_id: target.application_id,
        decision_scope: scope,
        // 注意：顶层 `stage_code` 是决策域的保留键（一律拒收），这里绝不输出；
        // 阶段码由决策工具按 scope 写死。decision_stage_code 仅作 undo_log 摘要保留。
        ...(scope === 'STAGE' && target.interview_id !== undefined
          ? { interview_id: target.interview_id }
          : {}),
        as_of: nowIso,
        // 撤销走 WITHDRAW（撤回原结论；HOLD/WITHDRAW 是既有域的止血动作，恒放行）。
        result: 'WITHDRAW',
        reason,
        basis_refs: [
          {
            kind: 'SUPERSEDES',
            decision_id: decisionId,
            reason,
            opened_by_actor_id: actorId,
          },
        ],
        supersedes: {
          decision_id: decisionId,
          reason,
          // 占位：Owner 从库读当前 decision 行的 record_version 后覆盖。
          expected_record_version: 0,
        },
        human_confirmation: {
          confirmed_by_actor_id: actorId,
          confirmed_at: nowIso,
          confirmation_method: 'IN_CHAT',
          confirmation_text: target.confirmation_text,
          confirmation_text_sha256: confirmationTextSha256,
        },
      },
      note: '低层域 recordDecisionInTransaction 的直接入参；supersedes.expected_record_version=0 为占位，Owner 必须先用库里当前 decision.record_version 覆盖，再调用（否则 VERSION_CONFLICT）。顶层不含 actor_id/tenant_id；嵌套 human_confirmation/basis_refs 中的身份来自执行上下文。既有 decision.record 事件由决策域写，本模块不写事件。',
    }
  }

  return {
    kind: 'SCHEDULE',
    domain: 'scheduleInTransaction',
    args: {
      intent: 'CANCEL',
      interview_id: target.interview_id ?? '',
      // 占位：Owner 从库读当前 interview 行的 record_version 后覆盖（parseScheduleArgs 要求 ≥1）。
      expected_record_version: 0,
      reason,
    },
    note: '既有 intent=CANCEL 入参（与 parseScheduleArgs 兼容）；reason 带“撤销：”前缀且 1..500。expected_record_version=0 为占位，Owner 必须用库里当前 interview.record_version 覆盖。顶层不含 actor_id/tenant_id；actor 由执行上下文提供。既有 interview.cancelled 事件由排期域写，本模块不写事件。',
  }
}
