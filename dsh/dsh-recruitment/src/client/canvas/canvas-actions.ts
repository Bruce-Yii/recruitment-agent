/**
 * Typed HTTP action clients for Recruitment OS DSH Plugin Canvas (Task 05).
 *
 * Contract rules (design/v4/contracts/available-actions.md & frontend-task-05-batch-undo.md):
 * - Same-origin cookie determines identity (frontend NEVER sends `actor`).
 * - Always carries `x-recruitment-request: 1`.
 * - Every write action requires `confirmation_text` (human verbatim confirmation).
 * - `job/create` NEVER sends `headcount` (HC is maintained on requisitions).
 * - `batch-reject` handles 200 partial failure per item using `message` (never `reason_code`).
 * - `undo` maps 409 conflict states to human copy (never exposes error codes).
 */

export const UNAVAILABLE_ACTION_MESSAGE = '这项还差最后一步，稍后开放';

export interface CanvasActionError extends Error {
  code: 'NOT_AVAILABLE' | 'ACTION_FAILED';
  userMessage: string;
}

function makeError(code: 'NOT_AVAILABLE' | 'ACTION_FAILED', userMessage: string): CanvasActionError {
  const err = new Error(userMessage) as CanvasActionError;
  err.code = code;
  err.userMessage = userMessage;
  return err;
}

async function postJsonAction<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'x-recruitment-request': '1',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 404 || res.status === 501) {
    throw makeError('NOT_AVAILABLE', UNAVAILABLE_ACTION_MESSAGE);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const summary =
      typeof data.error_summary === 'string' && data.error_summary.trim()
        ? data.error_summary
        : typeof data.message === 'string' && data.message.trim()
          ? data.message
          : '操作未能完成，请检查输入或稍后重试';
    throw makeError('ACTION_FAILED', summary);
  }
  return data as T;
}

export interface TransferPayload {
  applicationId: string;
  targetJobId: string;
  confirmationText: string;
  carryOverRefs?: Array<{
    source_application_id: string;
    ref_kind: 'SCORECARD' | 'TRANSCRIPT' | 'DECISION';
    ref_id: string;
  }>;
}

export async function postApplicationTransfer(payload: TransferPayload): Promise<{
  application_id: string;
  action_id?: string;
  carry_over_count?: number;
}> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    target_job_id: payload.targetJobId,
    confirmation_text: payload.confirmationText,
  };
  if (payload.carryOverRefs && payload.carryOverRefs.length > 0) {
    body.carry_over_refs = payload.carryOverRefs;
  }
  return postJsonAction('/recruitment/api/action/application/transfer', body);
}

export interface ConstraintPayload {
  action: 'PIN' | 'UNPIN' | 'HANDOFF';
  applicationId?: string;
  candidateId?: string;
  text: string;
  source: 'CHAT' | 'WEIXIN' | 'PHONE' | 'OTHER';
  interviewId?: string;
  confirmationText: string;
}

export async function postCandidateConstraint(payload: ConstraintPayload): Promise<{
  constraint_id: string;
  action_id?: string;
}> {
  const body: Record<string, unknown> = {
    action: payload.action,
    text: payload.text.slice(0, 500),
    source: payload.source,
    confirmation_text: payload.confirmationText,
  };
  if (payload.applicationId) body.application_id = payload.applicationId;
  else if (payload.candidateId) body.candidate_id = payload.candidateId;
  if (payload.interviewId) body.interview_id = payload.interviewId;
  return postJsonAction('/recruitment/api/action/candidate/constraint', body);
}

export interface JobCreatePayload {
  title: string;
  dept?: string;
  requisitionId?: string;
  confirmationText: string;
}

/**
 * NOTE: `headcount` is intentionally omitted because the backend rejects it
 * (`400 UNSUPPORTED_FIELD`). HC belongs to the requisition.
 */
export async function postJobCreate(payload: JobCreatePayload): Promise<{
  job_id: string;
  code: string;
  rubric_status: string;
  action_id?: string;
}> {
  const body: Record<string, unknown> = {
    title: payload.title.trim(),
    confirmation_text: payload.confirmationText,
  };
  if (payload.dept) body.dept = payload.dept;
  if (payload.requisitionId) body.requisition_id = payload.requisitionId;
  return postJsonAction('/recruitment/api/action/job/create', body);
}

export interface BatchRejectItemResult {
  applicationId: string;
  ok: boolean;
  message: string;
  actionId?: string;
}

export interface BatchRejectResponse {
  actionId?: string;
  succeededCount: number;
  failedCount: number;
  results: BatchRejectItemResult[];
}

/**
 * T5-1: Real batch reject endpoint.
 * POST /recruitment/api/action/decision/batch-reject
 * Partial failures still return HTTP 200 with per-item `results[]`;
 * UI displays human `message` only (never `reason_code`).
 */
export async function postBatchReject(payload: {
  applicationIds: string[];
  reason: string;
  confirmationText: string;
}): Promise<BatchRejectResponse> {
  const raw = await postJsonAction<Record<string, unknown>>(
    '/recruitment/api/action/decision/batch-reject',
    {
      application_ids: payload.applicationIds,
      reason: payload.reason,
      confirmation_text: payload.confirmationText,
    },
  );

  const rawResults = Array.isArray(raw.results) ? raw.results : [];
  const results: BatchRejectItemResult[] = rawResults.map((item) => {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const ok = r.ok === true || r.status === 'ok' || r.status === 'succeeded' || r.status === 'rejected';
    return {
      applicationId: String(r.application_id || r.applicationId || ''),
      ok,
      message:
        typeof r.message === 'string' && r.message.trim()
          ? r.message
          : ok
            ? '已关闭申请'
            : '当前状态无法执行不通过',
      actionId: typeof r.action_id === 'string' ? r.action_id : undefined,
    };
  });

  const succeededCount = results.filter((x) => x.ok).length;
  const failedCount = results.length - succeededCount;
  const topActionId =
    typeof raw.action_id === 'string'
      ? raw.action_id
      : results.find((x) => x.ok && x.actionId)?.actionId;

  return {
    actionId: topActionId,
    succeededCount,
    failedCount,
    results,
  };
}

export interface UndoResponse {
  undone: boolean;
  message: string;
}

/**
 * T5-2: Real 5-second undo endpoint.
 * POST /recruitment/api/action/undo
 * Maps 409 conflicts strictly to human copy without exposing error codes.
 */
export async function postActionUndo(payload: {
  actionId: string;
  confirmationText: string;
}): Promise<UndoResponse> {
  const res = await fetch('/recruitment/api/action/undo', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'x-recruitment-request': '1',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      action_id: payload.actionId,
      confirmation_text: payload.confirmationText,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.status === 409) {
    const code = String(
      data.code || data.reason_code || (data.error && typeof data.error === 'object' ? (data.error as Record<string, unknown>).code : '') || '',
    ).toUpperCase();
    if (code.includes('ALREADY_UNDONE')) {
      return { undone: false, message: '这条已经撤销过了' };
    }
    if (code.includes('WINDOW_EXPIRED')) {
      return { undone: false, message: '超过 5 分钟，不能再撤销' };
    }
    if (code.includes('SUPERSEDED')) {
      return { undone: false, message: '这条已经被后续操作覆盖，不能撤销' };
    }
    return { undone: false, message: '当前状态已变化，无法撤销这条操作' };
  }

  if (res.status === 404 || res.status === 501) {
    throw makeError('NOT_AVAILABLE', UNAVAILABLE_ACTION_MESSAGE);
  }

  if (!res.ok) {
    throw makeError('ACTION_FAILED', '暂时无法撤销，请刷新页面核对最新状态');
  }

  return {
    undone: data.status === 'undone' || res.ok,
    message: '已撤销',
  };
}

export interface UploadTaskStartResult {
  taskId: string;
  fileName: string;
}

export interface UploadTaskStatusResult {
  taskId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  applicationId?: string;
  candidateName?: string;
  /** Always human-readable; never raw error_code. */
  errorSummary?: string;
}

export async function uploadResumeRaw(file: File, jobId: string): Promise<UploadTaskStartResult> {
  const qs = jobId ? `?job_id=${encodeURIComponent(jobId)}` : '';
  const res = await fetch(`/recruitment/api/intake/upload${qs}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'x-recruitment-request': '1',
      'x-file-name': encodeURIComponent(file.name),
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      typeof data.error_summary === 'string' && data.error_summary.trim()
        ? data.error_summary
        : '简历上传未能提交，请稍后重试';
    throw makeError('ACTION_FAILED', msg);
  }
  return {
    taskId: String(data.task_id || data.id || ''),
    fileName: file.name,
  };
}

export async function fetchTaskStatus(taskId: string): Promise<UploadTaskStatusResult> {
  const res = await fetch(`/recruitment/api/tasks/status?task_id=${encodeURIComponent(taskId)}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      'x-recruitment-request': '1',
      Accept: 'application/json',
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      taskId,
      status: 'FAILED',
      errorSummary: '暂时无法查询解析进度，请稍后刷新查看',
    };
  }
  const task = (data.task && typeof data.task === 'object' ? data.task : data) as Record<string, unknown>;
  const st = String(task.status || 'RUNNING').toUpperCase();
  if (st === 'COMPLETED' || st === 'SUCCEEDED' || st === 'DONE') {
    return {
      taskId,
      status: 'COMPLETED',
      applicationId: typeof task.application_id === 'string' ? task.application_id : undefined,
      candidateName: typeof task.candidate_name === 'string' ? task.candidate_name : undefined,
    };
  }
  if (st === 'FAILED' || st === 'ERROR' || st === 'CANCELLED') {
    return {
      taskId,
      status: 'FAILED',
      errorSummary:
        typeof task.error_summary === 'string' && task.error_summary.trim()
          ? task.error_summary
          : '这份简历未能成功解析，请检查文件是否损坏或重新上传',
    };
  }
  return { taskId, status: 'RUNNING' };
}

export function triggerUnavailableAction(): never {
  throw makeError('NOT_AVAILABLE', UNAVAILABLE_ACTION_MESSAGE);
}

// ---------------- Task 07: Feishu Free Slots & Rebind Minute ----------------

export interface FreeSlotOption {
  startIso: string;
  endIso: string;
  label: string;
  busyConflicts: number;
}

export interface FreeSlotsResult {
  slots: FreeSlotOption[];
  unsatisfiedReasons: string[];
  calendarUnavailable: boolean;
  connectionLabel: string;
  unavailableBanner: string | null;
}

function formatLocalSlotLabel(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime())) return startIso;
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const mm = String(s.getMonth() + 1).padStart(2, '0');
  const dd = String(s.getDate()).padStart(2, '0');
  const sh = String(s.getHours()).padStart(2, '0');
  const sm = String(s.getMinutes()).padStart(2, '0');
  const eh = Number.isNaN(e.getTime()) ? '' : String(e.getHours()).padStart(2, '0');
  const em = Number.isNaN(e.getTime()) ? '' : String(e.getMinutes()).padStart(2, '0');
  const range = eh ? `${sh}:${sm}–${eh}:${em}` : `${sh}:${sm}`;
  return `${mm}-${dd} ${weekdays[s.getDay()]} ${range}`;
}

function mapUnsatisfiedReason(rawReason: string): string {
  const code = rawReason.toUpperCase();
  if (code.includes('NO_CALENDAR_BINDING')) return '这位面试官还没有绑定飞书日历';
  if (code.includes('AUTH')) return '这位面试官的飞书日历授权已过期，需要重新连接';
  return '这位面试官的飞书日历暂时无法读取';
}

/**
 * T7-1: Query real Feishu free slots before scheduling/rescheduling/adding a round.
 * GET /recruitment/api/action/interview/free-slots?application_id=<id>&interviewer_actor_ids=<id,id>&days=5&duration_minutes=45
 * NEVER mistakes calendar read failure for "no free time".
 */
export async function fetchInterviewFreeSlots(params: {
  applicationId: string;
  interviewerActorIds?: string[];
  days?: number;
  durationMinutes?: number;
}): Promise<FreeSlotsResult> {
  const qs = new URLSearchParams();
  qs.set('application_id', params.applicationId);
  if (params.interviewerActorIds && params.interviewerActorIds.length > 0) {
    qs.set('interviewer_actor_ids', params.interviewerActorIds.join(','));
  }
  qs.set('days', String(params.days ?? 5));
  qs.set('duration_minutes', String(params.durationMinutes ?? 45));

  try {
    const res = await fetch(`/recruitment/api/action/interview/free-slots?${qs.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        'x-recruitment-request': '1',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      return {
        slots: [],
        unsatisfiedReasons: [],
        calendarUnavailable: true,
        connectionLabel: 'NOT_CONNECTED',
        unavailableBanner: '日历暂时读不到，可以手动填时间',
      };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const labels = (data.labels && typeof data.labels === 'object' ? data.labels : {}) as Record<string, unknown>;
    const connection = typeof labels.connection === 'string' ? labels.connection : 'CONNECTED';
    const calendarUnavailable = connection !== 'CONNECTED';

    const rawSlots = Array.isArray(data.slots) ? data.slots : [];
    const slots: FreeSlotOption[] = rawSlots.slice(0, 3).map((item) => {
      const s = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const startIso = typeof s.start === 'string' ? s.start : '';
      const endIso = typeof s.end === 'string' ? s.end : '';
      return {
        startIso,
        endIso,
        label: formatLocalSlotLabel(startIso, endIso),
        busyConflicts: typeof s.busy_conflicts === 'number' ? s.busy_conflicts : 0,
      };
    }).filter((x) => x.startIso !== '');

    const rawUnsat = Array.isArray(data.unsatisfied) ? data.unsatisfied : [];
    const unsatisfiedReasons: string[] = Array.from(
      new Set(
        rawUnsat.map((item) => {
          const u = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
          return mapUnsatisfiedReason(typeof u.reason === 'string' ? u.reason : '');
        }),
      ),
    );

    return {
      slots,
      unsatisfiedReasons,
      calendarUnavailable,
      connectionLabel: connection,
      unavailableBanner: calendarUnavailable ? '日历暂时读不到，可以手动填时间' : null,
    };
  } catch {
    return {
      slots: [],
      unsatisfiedReasons: [],
      calendarUnavailable: true,
      connectionLabel: 'NOT_CONNECTED',
      unavailableBanner: '日历没连上，先重连再试；也可以直接手动填时间',
    };
  }
}

export async function postInterviewSchedule(payload: {
  applicationId: string;
  mode: 'schedule' | 'reschedule' | 'add_round';
  roundLabel?: string;
  replaceInterviewer?: string;
  startAt: string;
  endAt?: string;
  confirmationText: string;
}): Promise<{ interview_id?: string; action_id?: string }> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    mode: payload.mode,
    start_at: payload.startAt,
    confirmation_text: payload.confirmationText,
  };
  if (payload.endAt) body.end_at = payload.endAt;
  if (payload.roundLabel) body.round_label = payload.roundLabel;
  if (payload.replaceInterviewer) body.replace_interviewer = payload.replaceInterviewer;
  return postJsonAction('/recruitment/api/action/interview/schedule', body);
}

/**
 * T7-2: Rebind Feishu Minutes recording ownership after replacing an interviewer.
 * POST /recruitment/api/action/interview/rebind-minute
 * NEVER called without explicit human click + confirmation_text.
 * On failure, explicitly reassures that scorecards are NOT lost while ownership stays old.
 */
export async function postRebindMinute(payload: {
  interviewId: string;
  fromActorId: string;
  toActorId: string;
  minuteToken: string;
  confirmationText: string;
  dryRun?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const res = await fetch('/recruitment/api/action/interview/rebind-minute', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'x-recruitment-request': '1',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      interview_id: payload.interviewId,
      from_actor_id: payload.fromActorId,
      to_actor_id: payload.toActorId,
      minute_token: payload.minuteToken,
      confirmation_text: payload.confirmationText,
      dry_run: Boolean(payload.dryRun),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const rawReason =
      typeof data.error_summary === 'string' && data.error_summary.trim()
        ? data.error_summary.trim()
        : '飞书妙记权限校验未通过或连接中断';
    throw makeError('ACTION_FAILED', `${rawReason}。面评不会因此丢，但录音归属仍是旧的。`);
  }
  return {
    ok: true,
    message: '已把录音归属改到新面试官',
  };
}
