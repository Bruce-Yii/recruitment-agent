/**
 * Typed HTTP action clients for Recruitment OS DSH Plugin Canvas (Task 08c · D-160 / D-162).
 *
 * Contract discipline (V3-2 / client-contract-check):
 * - All standard recruiting write actions MUST reuse authoritative builders in
 *   `../recruiting/actions.ts` + `postActionSeam` / `postDecisionRecordFacade` / `postJobCreate` /
 *   `postJobDraft` / `postJobClose` in `../recruiting/use-recruiting.ts`.
 * - This module ONLY implements canvas-exclusive actions that have no recruiting builder yet:
 *   upload + task polling, Feishu free-slots + minute rebind, star, email send, batch-reject + undo,
 *   candidate constraint (PIN/HANDOFF), and application transfer.
 * - Every request carries `x-recruitment-request: 1` and `X-DSH-Session` injected from host props.
 */

export {
  buildScreeningDecisionBody,
  buildDecisionRecordBody,
  buildStageAdvanceBody,
  buildTranscriptImportBody,
  buildInterviewScheduleBody,
  buildSettingsWriteBody,
  buildJobCreateBody,
  buildJobDraftBody,
  buildJobCloseBody,
  buildRubricApproveBody,
  screeningDecisionBlockers,
  decisionRecordBlockers,
  blockerTextOf,
  describeActionError,
  toOffsetIso,
  newIdempotencyKey,
  type ActionOutcome,
  type BodyBuildResult,
  type DecisionFacts,
} from '../recruiting/actions.ts';

export {
  postActionSeam,
  postDecisionRecordFacade,
  postJobCreate,
  postJobDraft,
  postJobClose,
  fetchDecisionFacts,
  postScreeningEvaluate,
  type DecisionFactsProbe,
  type DecisionFactsResource,
} from '../recruiting/use-recruiting.ts';

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

/**
 * 画布写请求的会话头（D-160/V3-1 修复）。
 *
 * 服务端只认 `X-DSH-Session`（身份来自当前 DSH Session），缺了就是 400 SESSION_REQUIRED。
 * 会话 id 只能由宿主面板通过 props 传进来（`setCanvasSessionId`），不读 localStorage、不从 URL 取。
 */
let canvasSessionId: string | null = null;

export function setCanvasSessionId(id: string | null): void {
  canvasSessionId = id === '' ? null : id;
}

export function getCanvasSessionId(): string {
  return canvasSessionId ?? '';
}

export class CanvasSessionMissingError extends Error {
  constructor() {
    super('请先在工作台顶部选择身份，再执行这个操作');
    this.name = 'CanvasSessionMissingError';
  }
}

function sessionHeaders(): Record<string, string> {
  if (canvasSessionId === null) throw new CanvasSessionMissingError();
  return { 'X-DSH-Session': canvasSessionId };
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

// ---------------- 1. Candidate Star ----------------

export async function postApplicationStar(payload: {
  applicationId: string;
  starred: boolean;
}): Promise<{ starred: boolean }> {
  return postJsonAction('/recruitment/api/action/application/star', {
    application_id: payload.applicationId,
    starred: payload.starred,
  });
}

// ---------------- 2. Send Email (incl. Offer) ----------------

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

// ---------------- 3. Transfer & Candidate Constraint (PIN / HANDOFF) ----------------

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

// ---------------- 4. Batch Reject & Undo ----------------

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

// ---------------- 5. Upload & Task Status Polling ----------------

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

// ---------------- 6. Feishu Free Slots & Rebind Minute ----------------

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
      headers: { 'x-recruitment-request': '1', Accept: 'application/json', ...sessionHeaders() },
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

export type CriterionHumanState = 'PRESENT' | 'ABSENT' | 'UNREADABLE';

export interface CriterionOverridePayload {
  readonly applicationId: string;
  readonly criterionKey: string;
  readonly humanState: CriterionHumanState;
  readonly note?: string;
  readonly confirmationText: string;
}

export async function postCriterionOverride(payload: CriterionOverridePayload): Promise<{
  readonly overrideId: string;
  readonly effectiveState: string;
}> {
  const body: Record<string, unknown> = {
    application_id: payload.applicationId,
    criterion_key: payload.criterionKey,
    human_state: payload.humanState,
    confirmation_text: payload.confirmationText.trim(),
  };
  const trimmedNote = (payload.note ?? '').trim();
  if (trimmedNote) body.note = trimmedNote.slice(0, 500);
  const res = await postJsonAction<{
    override?: { override_id?: string; effective_state?: string };
  }>('/recruitment/api/action/criterion/override', body);
  return {
    overrideId: String(res.override?.override_id ?? ''),
    effectiveState: String(res.override?.effective_state ?? payload.humanState),
  };
}

export interface MaterialPageImageResult {
  readonly kind: 'image' | 'unsupported' | 'error';
  readonly objectUrl?: string;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly message?: string;
}

export async function fetchMaterialPageImage(
  materialContentUrl: string,
  pageNo: number,
  signal?: AbortSignal,
): Promise<MaterialPageImageResult> {
  const pageUrl = materialContentUrl.replace(/\/content(\?.*)?$/, `/page/${pageNo}`);
  if (!pageUrl || pageUrl === materialContentUrl) {
    return { kind: 'unsupported', pageNumber: pageNo, pageCount: 1, message: '当前原件暂不支持逐页图预览。' };
  }
  try {
    const res = await fetch(pageUrl, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: {
        'x-recruitment-request': '1',
        ...sessionHeaders(),
        Accept: 'image/png, application/json',
      },
    });
    if (res.status === 415) {
      return {
        kind: 'unsupported',
        pageNumber: pageNo,
        pageCount: 1,
        message: '该格式暂不支持逐页图预览，可下载原件或查看结构化原文。',
      };
    }
    if (!res.ok) {
      return {
        kind: 'error',
        pageNumber: pageNo,
        pageCount: 1,
        message: '暂时无法渲染该页原件预览，可点击右侧在新标签页查看原件。',
      };
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const totalHeader = Number(res.headers.get('x-page-count') || '1');
    const pageCount = Number.isFinite(totalHeader) && totalHeader >= 1 ? totalHeader : 1;
    return { kind: 'image', objectUrl, pageNumber: pageNo, pageCount };
  } catch {
    return { kind: 'error', pageNumber: pageNo, pageCount: 1, message: '原件预览加载中断，请稍后重试。' };
  }
}

export interface BookingInviteSlotInput {
  readonly start: string;
  readonly end: string;
}

export interface BookingInvitePayload {
  readonly applicationId: string;
  readonly roundNo: number;
  readonly durationMinutes: number;
  readonly interviewerActorIds: readonly string[];
  readonly timezone: string;
  readonly slots: readonly BookingInviteSlotInput[];
  readonly expiresHours?: number;
}

export interface BookingInviteResult {
  readonly inviteId: string;
  readonly token: string;
  readonly bookingUrl: string;
  readonly expiresAt: string;
}

export async function postBookingInvite(payload: BookingInvitePayload): Promise<BookingInviteResult> {
  const res = await postJsonAction<{
    invite_id?: string;
    token?: string;
    booking_url?: string;
    expires_at?: string;
  }>('/recruitment/api/action/booking/invite', {
    application_id: payload.applicationId,
    round_no: payload.roundNo,
    duration_minutes: payload.durationMinutes,
    interviewer_actor_ids: payload.interviewerActorIds,
    timezone: payload.timezone,
    slots: payload.slots,
    ...(payload.expiresHours ? { expires_hours: payload.expiresHours } : {}),
  });
  return {
    inviteId: String(res.invite_id ?? ''),
    token: String(res.token ?? ''),
    bookingUrl: String(res.booking_url ?? ''),
    expiresAt: String(res.expires_at ?? ''),
  };
}

export function triggerUnavailableAction(): never {
  throw makeError('NOT_AVAILABLE', UNAVAILABLE_ACTION_MESSAGE);
}
