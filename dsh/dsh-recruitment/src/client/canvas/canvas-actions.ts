/**
 * Typed HTTP action clients for Recruitment OS DSH Plugin Canvas (Task 03).
 *
 * Contract rules (design/v4/contracts/available-actions.md & client-plugin-contract.md):
 * - Same-origin cookie determines identity (frontend NEVER sends `actor`).
 * - Always carries `x-recruitment-request: 1`.
 * - Every write action requires `confirmation_text` (human verbatim confirmation).
 * - `job/create` NEVER sends `headcount` (HC is maintained on requisitions).
 * - Unimplemented actions throw `NOT_AVAILABLE` with human copy '这项还差最后一步，稍后开放'.
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
}> {
  const body: Record<string, unknown> = {
    title: payload.title.trim(),
    confirmation_text: payload.confirmationText,
  };
  if (payload.dept) body.dept = payload.dept;
  if (payload.requisitionId) body.requisition_id = payload.requisitionId;
  return postJsonAction('/recruitment/api/action/job/create', body);
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

/**
 * Raw-byte upload returning task_id immediately (T3-2 & T3-3).
 * POST /recruitment/api/intake/upload?job_id=<uuid>
 */
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

/**
 * Polls GET /recruitment/api/tasks/status?task_id=<uuid>.
 * Never exposes raw error_code; maps failures to human-readable errorSummary.
 */
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

/** Helper for T3-4 unimplemented actions (batch_reject, nudge, compound, star, draft, undo). */
export function triggerUnavailableAction(): never {
  throw makeError('NOT_AVAILABLE', UNAVAILABLE_ACTION_MESSAGE);
}
