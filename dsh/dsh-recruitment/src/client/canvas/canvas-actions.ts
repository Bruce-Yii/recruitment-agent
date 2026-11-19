/**
 * Typed HTTP action clients for Recruitment OS DSH Plugin Canvas (Task 08 · D-160 Full Parity).
 *
 * Covers ALL reachable write routes in docs/38-capability-entry-matrix.md (except deferred #9 compound):
 *  1. POST /recruitment/api/action/screening/decide
 *  2. POST /recruitment/api/decision/record
 *  3. POST /recruitment/api/action/stage/advance
 *  4. POST /recruitment/api/action/transcript/import
 *  5. POST /recruitment/api/action/interview/schedule (schedule / reschedule / replace / add_round / NO_SHOW)
 *  6. POST /recruitment/api/intake/upload?job_id=... + GET /recruitment/api/tasks/status
 *  7. POST /recruitment/api/action/application/star
 *  8. POST /recruitment/api/action/email/send
 *  9. POST /recruitment/api/action/settings/write
 * 10. POST /recruitment/api/action/decision/batch-reject & POST /recruitment/api/action/undo
 * 11. POST /recruitment/api/action/candidate/constraint & POST /recruitment/api/action/application/transfer
 * 12. POST /recruitment/api/action/job/create
 * 13. GET  /recruitment/api/action/interview/free-slots & POST /recruitment/api/action/interview/rebind-minute
 *
 * Contract rules:
 * - Same-origin cookie determines identity (frontend NEVER sends `actor`).
 * - Always carries `x-recruitment-request: 1`.
 * - Optimistic locking: passes `expected_record_version` and maps 409 version conflict to
 *   human copy "这条刚被别人改过，请刷新".
 */

export const UNAVAILABLE_ACTION_MESSAGE = '这项还差最后一步，稍后开放';

export interface CanvasActionError extends Error {
  code: 'NOT_AVAILABLE' | 'VERSION_CONFLICT' | 'DUPLICATE_DECISION' | 'SCORECARD_MISSING' | 'ACTION_FAILED';
  userMessage: string;
}

function makeError(code: CanvasActionError['code'], userMessage: string): CanvasActionError {
  const err = new Error(userMessage) as CanvasActionError;
  err.code = code;
  err.userMessage = userMessage;
  return err;
}

function extractErrorCode(data: Record<string, unknown>): string {
  const nested = data.error && typeof data.error === 'object' ? (data.error as Record<string, unknown>) : {};
  return String(data.reason_code || data.code || nested.reason_code || nested.code || '').toUpperCase();
}

async function postJsonAction<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'x-recruitment-request': '1',
      ...sessionHeaders(),
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 404 || res.status === 501) {
    throw makeError('NOT_AVAILABLE', UNAVAILABLE_ACTION_MESSAGE);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = extractErrorCode(data);
    if (res.status === 409 && (code.includes('VERSION') || code.includes('CONFLICT') || code.includes('STALE') || code.includes('LOCK'))) {
      throw makeError('VERSION_CONFLICT', '这条刚被别人改过，请刷新');
    }
    if (res.status === 409 && (code.includes('DUPLICATE') || code.includes('ALREADY'))) {
      throw makeError('DUPLICATE_DECISION', '已处理过，不会重复写入');
    }
    if (code.includes('SCORECARD_MISSING')) {
      throw makeError('SCORECARD_MISSING', '还有面试官尚未提交面评，暂时不能提交终审决策');
    }
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

/**
 * 画布写请求的会话头（D-160/V3-1 修复）。
 *
 * 服务端只认 `X-DSH-Session`（身份来自当前 DSH Session），缺了就是 400 SESSION_REQUIRED。
 * 会话 id 只能由宿主面板通过 props 传进来（`setCanvasSessionId`），**不读 localStorage、不从 URL 取**。
 */
let canvasSessionId: string | null = null

export function setCanvasSessionId(id: string | null): void {
  canvasSessionId = id === '' ? null : id
}

export class CanvasSessionMissingError extends Error {
  constructor() {
    super('请先在工作台顶部选择身份，再执行这个操作')
    this.name = 'CanvasSessionMissingError'
  }
}

function sessionHeaders(): Record<string, string> {
  if (canvasSessionId === null) throw new CanvasSessionMissingError()
  return { 'X-DSH-Session': canvasSessionId }
}

export async function postScreeningDecide(payload: {
  applicationId: string;
  result: 'ADVANCE' | 'REJECT' | 'HOLD';
  reason: string;
  confirmationText: string;
  expectedRecordVersion?: number;
}): Promise<{ decision_id?: string; action_id?: string }> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    result: payload.result,
    reason: payload.reason,
    confirmation_text: payload.confirmationText,
  };
  if (typeof payload.expectedRecordVersion === 'number') {
    body.expected_record_version = payload.expectedRecordVersion;
  }
  return postJsonAction('/recruitment/api/action/screening/decide', body);
}

export async function postDecisionRecord(payload: {
  applicationId: string;
  result: 'OFFER' | 'REJECT' | 'HOLD';
  reason: string;
  confirmationText: string;
  expectedRecordVersion?: number;
}): Promise<{ decision_id?: string; action_id?: string }> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    result: payload.result,
    reason: payload.reason,
    confirmation_text: payload.confirmationText,
  };
  if (typeof payload.expectedRecordVersion === 'number') {
    body.expected_record_version = payload.expectedRecordVersion;
  }
  return postJsonAction('/recruitment/api/decision/record', body);
}

export async function postStageAdvance(payload: {
  applicationId: string;
  targetStageCode: string;
  reason?: string;
  confirmationText: string;
  expectedRecordVersion?: number;
}): Promise<{ action_id?: string }> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    target_stage_code: payload.targetStageCode,
    confirmation_text: payload.confirmationText,
  };
  if (payload.reason) body.reason = payload.reason;
  if (typeof payload.expectedRecordVersion === 'number') {
    body.expected_record_version = payload.expectedRecordVersion;
  }
  return postJsonAction('/recruitment/api/action/stage/advance', body);
}

export async function postTranscriptImport(payload: {
  applicationId: string;
  interviewId?: string;
  sourceUrlOrText: string;
  confirmationText: string;
}): Promise<{ artifact_id?: string; action_id?: string }> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    content: payload.sourceUrlOrText,
    confirmation_text: payload.confirmationText,
  };
  if (payload.interviewId) body.interview_id = payload.interviewId;
  return postJsonAction('/recruitment/api/action/transcript/import', body);
}

export async function postApplicationStar(payload: {
  applicationId: string;
  starred: boolean;
}): Promise<{ starred: boolean }> {
  return postJsonAction('/recruitment/api/action/application/star', {
    application_id: payload.applicationId,
    starred: payload.starred,
  });
}

export async function postEmailSend(payload: {
  applicationId: string;
  template: 'OFFER' | 'INVITE' | 'THANK_YOU';
  subject: string;
  bodyText: string;
  confirmationText: string;
  expectedRecordVersion?: number;
}): Promise<{ message_id?: string; action_id?: string }> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    template: payload.template,
    subject: payload.subject,
    body: payload.bodyText,
    confirmation_text: payload.confirmationText,
  };
  if (typeof payload.expectedRecordVersion === 'number') {
    body.expected_record_version = payload.expectedRecordVersion;
  }
  return postJsonAction('/recruitment/api/action/email/send', body);
}

export async function postSettingsWrite(payload: {
  agentSilentDelegation?: boolean;
  screeningHours?: number;
  scorecardHours?: number;
  confirmationText: string;
}): Promise<{ ok?: boolean; action_id?: string }> {
  const body: Record<string, unknown> = {
    confirmation_text: payload.confirmationText,
  };
  if (typeof payload.agentSilentDelegation === 'boolean') {
    body.agent_silent_delegation = payload.agentSilentDelegation;
  }
  if (typeof payload.screeningHours === 'number' || typeof payload.scorecardHours === 'number') {
    body.sla_thresholds = {
      ...(typeof payload.screeningHours === 'number' ? { screening_hours: payload.screeningHours } : {}),
      ...(typeof payload.scorecardHours === 'number' ? { scorecard_hours: payload.scorecardHours } : {}),
    };
  }
  return postJsonAction('/recruitment/api/action/settings/write', body);
}

export interface TransferPayload {
  applicationId: string;
  targetJobId: string;
  confirmationText: string;
  expectedRecordVersion?: number;
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
  if (typeof payload.expectedRecordVersion === 'number') {
    body.expected_record_version = payload.expectedRecordVersion;
  }
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
  return {
    actionId: typeof raw.action_id === 'string' ? raw.action_id : results.find((x) => x.ok && x.actionId)?.actionId,
    succeededCount,
    failedCount: results.length - succeededCount,
    results,
  };
}

export interface UndoResponse {
  undone: boolean;
  message: string;
}

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
      ...sessionHeaders(),
      Accept: 'application/json',
    },
    body: JSON.stringify({
      action_id: payload.actionId,
      confirmation_text: payload.confirmationText,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 409) {
    const code = extractErrorCode(data);
    if (code.includes('ALREADY_UNDONE')) return { undone: false, message: '这条已经撤销过了' };
    if (code.includes('WINDOW_EXPIRED')) return { undone: false, message: '超过 5 分钟，不能再撤销' };
    if (code.includes('SUPERSEDED')) return { undone: false, message: '这条已经被后续操作覆盖，不能撤销' };
    return { undone: false, message: '当前状态已变化，无法撤销这条操作' };
  }
  if (res.status === 404 || res.status === 501) throw makeError('NOT_AVAILABLE', UNAVAILABLE_ACTION_MESSAGE);
  if (!res.ok) throw makeError('ACTION_FAILED', '暂时无法撤销，请刷新页面核对最新状态');
  return { undone: data.status === 'undone' || res.ok, message: '已撤销' };
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
  errorSummary?: string;
}

export async function uploadResumeRaw(file: File, jobId: string): Promise<UploadTaskStartResult> {
  const qs = jobId ? `?job_id=${encodeURIComponent(jobId)}` : '';
  const res = await fetch(`/recruitment/api/intake/upload${qs}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'x-recruitment-request': '1',
      ...sessionHeaders(),
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
  return { taskId: String(data.task_id || data.id || ''), fileName: file.name };
}

export async function fetchTaskStatus(taskId: string): Promise<UploadTaskStatusResult> {
  const res = await fetch(`/recruitment/api/tasks/status?task_id=${encodeURIComponent(taskId)}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'x-recruitment-request': '1', Accept: 'application/json', ...sessionHeaders() },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return { taskId, status: 'FAILED', errorSummary: '暂时无法查询解析进度，请稍后刷新查看' };
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
      headers: { 'x-recruitment-request': '1', Accept: 'application/json' },
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
    const slots: FreeSlotOption[] = rawSlots
      .slice(0, 3)
      .map((item) => {
        const s = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const startIso = typeof s.start === 'string' ? s.start : '';
        const endIso = typeof s.end === 'string' ? s.end : '';
        return {
          startIso,
          endIso,
          label: formatLocalSlotLabel(startIso, endIso),
          busyConflicts: typeof s.busy_conflicts === 'number' ? s.busy_conflicts : 0,
        };
      })
      .filter((x) => x.startIso !== '');

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
  intent: 'CREATE' | 'RESCHEDULE' | 'NO_SHOW';
  interviewId?: string;
  interviewerActorIds?: string[];
  roundLabel?: string;
  replaceInterviewer?: string;
  startAt?: string;
  endAt?: string;
  noShowSubject?: 'CANDIDATE' | 'INTERVIEWER';
  reason?: string;
  confirmationText: string;
  expectedRecordVersion?: number;
}): Promise<{ interview_id?: string; action_id?: string }> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    intent: payload.intent,
    confirmation_text: payload.confirmationText,
  };
  if (payload.interviewId) body.interview_id = payload.interviewId;
  if (payload.interviewerActorIds && payload.interviewerActorIds.length > 0) {
    body.interviewer_actor_ids = payload.interviewerActorIds;
  }
  if (payload.roundLabel) body.round_label = payload.roundLabel;
  if (payload.replaceInterviewer) body.replace_interviewer = payload.replaceInterviewer;
  if (payload.startAt) body.start_at = payload.startAt;
  if (payload.endAt) body.end_at = payload.endAt;
  if (payload.noShowSubject) body.subject = payload.noShowSubject;
  if (payload.reason) body.reason = payload.reason;
  if (typeof payload.expectedRecordVersion === 'number') {
    body.expected_record_version = payload.expectedRecordVersion;
  }
  return postJsonAction('/recruitment/api/action/interview/schedule', body);
}

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
      ...sessionHeaders(),
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
  return { ok: true, message: '已把录音归属改到新面试官' };
}

export function triggerUnavailableAction(): never {
  throw makeError('NOT_AVAILABLE', UNAVAILABLE_ACTION_MESSAGE);
}
