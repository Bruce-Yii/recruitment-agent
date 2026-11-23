successfully downloaded text file (SHA: e4e7484c28343a7569bc44fb83ab0c2427a64f7e)
import {
  normalizeOverviewView,
  type RecruitingOverviewView,
} from '../client/recruiting/view-model.ts';
import { setCanvasSessionId } from '../client/canvas/canvas-actions.ts';

export interface AppSessionInfo {
  readonly sid: string;
  readonly bound: boolean;
  readonly alias: string | null;
  readonly actorId: string | null;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export interface AgentToolEvent {
  readonly name: string;
  readonly status: 'start' | 'ok' | 'error';
  readonly input?: unknown;
  readonly result?: unknown;
  readonly message?: string;
}

export type AgentUiActionType = 'navigate' | 'focus_section' | 'suggest_action' | 'propose_write';
export type AgentUiWriteIntent =
  | 'screening_decide'
  | 'stage_advance'
  | 'candidate_constraint'
  | 'interview_schedule'
  | 'decision_record';

export interface AgentUiWriteSummaryItem {
  readonly label: string;
  readonly value: string;
}

export interface AgentUiWriteProposalPayload {
  readonly decision?: 'PASS' | 'REJECT';
  readonly rationale?: string;
  readonly target_stage?: string;
  readonly constraint_kind?: 'PIN' | 'HANDOFF';
  readonly constraint_text?: string;
  readonly round_number?: number;
  readonly interviewer_id?: string;
  readonly scheduled_start?: string;
  readonly scheduled_end?: string;
  readonly timezone?: string;
  readonly final_outcome?: 'HIRE' | 'REJECT' | 'HOLD';
}

export interface AgentUiWriteProposal {
  readonly intent: AgentUiWriteIntent;
  readonly application_id: string;
  readonly title: string;
  readonly tone?: 'default' | 'danger';
  readonly summary: readonly AgentUiWriteSummaryItem[];
  readonly fallback_modal?: AgentUiModalKind;
  readonly payload: AgentUiWriteProposalPayload;
}
export type AgentUiRouteKind = 'queue' | 'jobs' | 'talent' | 'application' | 'job' | 'interviewer' | 'settings';
export type AgentUiQueueFilter = 'all' | 'screening' | 'interviewing';
export type AgentUiSectionKind =
  | 'summary'
  | 'criteria'
  | 'resume'
  | 'interviews'
  | 'rubric'
  | 'candidates';
export type AgentUiModalKind = 'schedule' | 'screening' | 'decision' | 'email' | 'transfer';

export interface AgentUiAction {
  readonly action: AgentUiActionType;
  readonly route?: AgentUiRouteKind;
  readonly target_id?: string;
  readonly filter?: AgentUiQueueFilter;
  readonly section?: AgentUiSectionKind;
  readonly modal?: AgentUiModalKind;
  readonly label?: string;
  readonly proposal?: AgentUiWriteProposal;
}

export interface StreamAgentTurnOptions {
  readonly sid: string;
  readonly text: string;
  readonly context: {
    readonly route: string;
    readonly application_id?: string;
    readonly job_id?: string;
  };
  readonly signal?: AbortSignal;
  readonly onDelta: (chunk: string) => void;
  readonly onTool: (tool: AgentToolEvent) => void;
  readonly onUiAction?: (action: AgentUiAction) => void;
  readonly onDone: (payload: { turnId?: string }) => void;
  readonly onUnavailable: (message: string) => void;
  readonly onError: (message: string) => void;
}

export function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${name}=`;
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return '';
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

const VALID_UI_ACTIONS: readonly AgentUiActionType[] = [
  'navigate',
  'focus_section',
  'suggest_action',
  'propose_write',
];
const VALID_WRITE_INTENTS: readonly AgentUiWriteIntent[] = [
  'screening_decide',
  'stage_advance',
  'candidate_constraint',
  'interview_schedule',
  'decision_record',
];

function parseWriteProposal(raw: unknown): AgentUiWriteProposal | undefined {
  const obj = asRecord(raw);
  const intentRaw = asString(obj.intent);
  if (!(VALID_WRITE_INTENTS as readonly string[]).includes(intentRaw)) return undefined;
  const applicationId = asString(obj.application_id);
  const title = asString(obj.title);
  if (!applicationId || !title) return undefined;
  const rawSummary = Array.isArray(obj.summary) ? obj.summary : [];
  const summary: AgentUiWriteSummaryItem[] = rawSummary
    .map((item) => {
      const rec = asRecord(item);
      const label = asString(rec.label);
      const value = asString(rec.value);
      return label && value ? { label, value } : null;
    })
    .filter((item): item is AgentUiWriteSummaryItem => item !== null)
    .slice(0, 4);
  if (summary.length === 0) return undefined;
  const toneRaw = asString(obj.tone);
  const tone: 'default' | 'danger' | undefined =
    toneRaw === 'danger' ? 'danger' : toneRaw === 'default' ? 'default' : undefined;
  const fallbackRaw = asString(obj.fallback_modal);
  const fallbackModal = (VALID_UI_MODALS as readonly string[]).includes(fallbackRaw)
    ? (fallbackRaw as AgentUiModalKind)
    : undefined;
  const p = asRecord(obj.payload);
  const decisionRaw = asString(p.decision);
  const constraintKindRaw = asString(p.constraint_kind);
  const outcomeRaw = asString(p.final_outcome);
  const payload: AgentUiWriteProposalPayload = {
    ...(decisionRaw === 'PASS' || decisionRaw === 'REJECT' ? { decision: decisionRaw } : {}),
    ...(asString(p.rationale) ? { rationale: asString(p.rationale) } : {}),
    ...(asString(p.target_stage) ? { target_stage: asString(p.target_stage) } : {}),
    ...(constraintKindRaw === 'PIN' || constraintKindRaw === 'HANDOFF'
      ? { constraint_kind: constraintKindRaw }
      : {}),
    ...(asString(p.constraint_text) ? { constraint_text: asString(p.constraint_text) } : {}),
    ...(typeof p.round_number === 'number' && Number.isFinite(p.round_number)
      ? { round_number: p.round_number }
      : {}),
    ...(asString(p.interviewer_id) ? { interviewer_id: asString(p.interviewer_id) } : {}),
    ...(asString(p.scheduled_start) ? { scheduled_start: asString(p.scheduled_start) } : {}),
    ...(asString(p.scheduled_end) ? { scheduled_end: asString(p.scheduled_end) } : {}),
    ...(asString(p.timezone) ? { timezone: asString(p.timezone) } : {}),
    ...(outcomeRaw === 'HIRE' || outcomeRaw === 'REJECT' || outcomeRaw === 'HOLD'
      ? { final_outcome: outcomeRaw }
      : {}),
  };
  return {
    intent: intentRaw as AgentUiWriteIntent,
    application_id: applicationId,
    title,
    ...(tone ? { tone } : {}),
    summary,
    ...(fallbackModal ? { fallback_modal: fallbackModal } : {}),
    payload,
  };
}
const VALID_UI_ROUTES: readonly AgentUiRouteKind[] = [
  'queue',
  'jobs',
  'talent',
  'application',
  'job',
  'interviewer',
];
const VALID_UI_FILTERS: readonly AgentUiQueueFilter[] = ['all', 'screening', 'interviewing'];
const VALID_UI_SECTIONS: readonly AgentUiSectionKind[] = [
  'summary',
  'criteria',
  'resume',
  'interviews',
  'rubric',
  'candidates',
];
const VALID_UI_MODALS: readonly AgentUiModalKind[] = [
  'schedule',
  'screening',
  'decision',
  'email',
  'transfer',
];

function parseAgentUiAction(raw: Record<string, unknown>): AgentUiAction | null {
  const action = asString(raw.action);
  if (!(VALID_UI_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  const routeRaw = asString(raw.route);
  const route = (VALID_UI_ROUTES as readonly string[]).includes(routeRaw)
    ? (routeRaw as AgentUiRouteKind)
    : undefined;
  const filterRaw = asString(raw.filter);
  const filter = (VALID_UI_FILTERS as readonly string[]).includes(filterRaw)
    ? (filterRaw as AgentUiQueueFilter)
    : undefined;
  const sectionRaw = asString(raw.section);
  const section = (VALID_UI_SECTIONS as readonly string[]).includes(sectionRaw)
    ? (sectionRaw as AgentUiSectionKind)
    : undefined;
  const modalRaw = asString(raw.modal);
  const modal = (VALID_UI_MODALS as readonly string[]).includes(modalRaw)
    ? (modalRaw as AgentUiModalKind)
    : undefined;
  const targetId = asString(raw.target_id) || undefined;
  const label = asString(raw.label) || undefined;
  const proposal = action === 'propose_write' ? parseWriteProposal(raw.proposal) : undefined;
  if (action === 'propose_write' && !proposal) {
    return null;
  }

  return {
    action: action as AgentUiActionType,
    ...(route ? { route } : {}),
    ...(targetId ? { target_id: targetId } : {}),
    ...(filter ? { filter } : {}),
    ...(section ? { section } : {}),
    ...(modal ? { modal } : {}),
    ...(label ? { label } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

function extractErrorMessage(raw: unknown, fallback: string): string {
  const obj = asRecord(raw);
  const err = asRecord(obj.error);
  const msg = asString(err.message) || asString(obj.message);
  return msg || fallback;
}

export function isInterviewerOnly(roles: readonly string[]): boolean {
  const normalized = roles.map((r) => r.toLowerCase());
  const hasInterviewer = normalized.some((r) => r.includes('interviewer'));
  const hasRecruiter = normalized.some(
    (r) => r.includes('recruiter') || r.includes('admin') || r.includes('hr') || r.includes('owner'),
  );
  return hasInterviewer && !hasRecruiter;
}

export function formatRolesLabel(roles: readonly string[], displayName = ''): string {
  if (roles.length === 0) return '';
  const mapped = roles
    .map((r) => {
      const low = r.toLowerCase();
      if (low.includes('recruiter')) return '招聘负责人';
      if (low.includes('hr_specialist') || low === 'hr') return 'HR';
      if (low.includes('interviewer')) return '面试官';
      if (low.includes('hiring_manager') || low.includes('manager')) return '用人经理';
      if (low.includes('admin')) return '管理员';
      return /^[A-Z0-9_]+$/.test(r) ? '' : r;
    })
    .filter((label) => label.length > 0 && label !== displayName.trim());
  const unique = Array.from(new Set(mapped));
  if (unique.length === 0) return '';
  return unique[0];
}

export async function fetchAppSession(): Promise<AppSessionInfo> {
  const cookieSid = readCookie('rc_sid');
  const headers: Record<string, string> = {
    'x-recruitment-request': '1',
    Accept: 'application/json',
  };
  if (cookieSid) {
    headers['X-DSH-Session'] = cookieSid;
  }

  const res = await fetch('/recruitment/app/session', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
  });

  if (!res.ok) {
    throw new Error('无法获取当前会话信息，请刷新页面重试。');
  }

  const raw = asRecord(await res.json());
  const actorObj = asRecord(raw.actor);
  const sid = asString(raw.sid) || asString(raw.session_id) || cookieSid;
  const actorId = asString(raw.actor_id) || asString(actorObj.actor_id) || asString(actorObj.id) || null;
  const alias = asString(raw.alias) || asString(actorObj.alias) || null;
  const displayName =
    asString(raw.display_name) ||
    asString(actorObj.display_name) ||
    asString(actorObj.name) ||
    alias ||
    '';
  const rawRoles = Array.isArray(raw.roles)
    ? raw.roles
    : Array.isArray(actorObj.roles)
      ? actorObj.roles
      : [];
  const roles = rawRoles
    .map((r) => (typeof r === 'string' ? r.trim() : ''))
    .filter((r) => r.length > 0);
  const bound =
    typeof raw.bound === 'boolean'
      ? raw.bound
      : Boolean(actorId || alias || displayName);

  if (sid) {
    setCanvasSessionId(sid);
  }

  return {
    sid,
    bound,
    alias,
    actorId,
    displayName,
    roles,
  };
}

export async function fetchAppOverview(sid: string): Promise<RecruitingOverviewView> {
  const headers: Record<string, string> = {
    'x-recruitment-request': '1',
    Accept: 'application/json',
  };
  if (sid) {
    headers['X-DSH-Session'] = sid;
  }

  const res = await fetch('/recruitment/api/recruiting/overview', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
  });

  if (!res.ok) {
    let msg = '暂时无法加载工作台数据，请稍后重试。';
    try {
      msg = extractErrorMessage(await res.json(), msg);
    } catch {
      // ignore json parse failure
    }
    throw new Error(msg);
  }

  return normalizeOverviewView(await res.json());
}

export async function fetchAppJson(path: string, sid: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'x-recruitment-request': '1',
    Accept: 'application/json',
  };
  if (sid) {
    headers['X-DSH-Session'] = sid;
  }

  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
  });

  if (!res.ok) {
    throw new Error('读取服务信息失败');
  }
  return asRecord(await res.json());
}

export async function streamAgentTurn(opts: StreamAgentTurnOptions): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-recruitment-request': '1',
    Accept: 'text/event-stream',
  };
  if (opts.sid) {
    headers['X-DSH-Session'] = opts.sid;
  }

  let res: Response;
  try {
    res = await fetch('/recruitment/agent/turn', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      signal: opts.signal,
      body: JSON.stringify({
        text: opts.text,
        context: opts.context,
      }),
    });
  } catch {
    if (opts.signal?.aborted) return;
    opts.onError('网络暂时不可用，请检查连接后重试。');
    return;
  }

  if (res.status === 503) {
    let msg = '对话暂时不可用，右侧工作台操作不受影响。';
    try {
      msg = extractErrorMessage(await res.json(), msg);
    } catch {
      // keep default message
    }
    opts.onUnavailable(msg);
    return;
  }

  if (!res.ok) {
    let msg = '对话服务返回异常，请稍后重试。';
    try {
      const payload = await res.json();
      const errObj = asRecord(asRecord(payload).error);
      if (asString(errObj.code) === 'AGENT_UNAVAILABLE') {
        opts.onUnavailable(extractErrorMessage(payload, '对话暂时不可用，右侧工作台操作不受影响。'));
        return;
      }
      msg = extractErrorMessage(payload, msg);
    } catch {
      // ignore
    }
    opts.onError(msg);
    return;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!res.body || !contentType.includes('text/event-stream')) {
    try {
      const payload = asRecord(await res.json());
      const text = asString(payload.text) || asString(payload.reply);
      if (text) opts.onDelta(text);
      opts.onDone({ turnId: asString(payload.turn_id) || undefined });
    } catch {
      opts.onDone({});
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatchFrame = (rawFrame: string) => {
    const lines = rawFrame.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const dataRaw = dataLines.join('\n');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = asRecord(JSON.parse(dataRaw));
    } catch {
      if (eventName === 'delta') {
        opts.onDelta(dataRaw);
      }
      return;
    }

    if (eventName === 'delta') {
      const chunk = typeof parsed.text === 'string' ? parsed.text : '';
      if (chunk) opts.onDelta(chunk);
    } else if (eventName === 'tool') {
      const rawStatus = asString(parsed.status);
      const status: 'start' | 'ok' | 'error' =
        rawStatus === 'ok' || rawStatus === 'error' ? rawStatus : 'start';
      opts.onTool({
        name: asString(parsed.name, 'tool'),
        status,
        input: parsed.input,
        result: parsed.result,
        message: asString(parsed.message) || undefined,
      });
    } else if (eventName === 'ui_action') {
      const uiAction = parseAgentUiAction(parsed);
      if (uiAction) {
        opts.onUiAction?.(uiAction);
      }
    } else if (eventName === 'done') {
      opts.onDone({ turnId: asString(parsed.turn_id) || undefined });
    } else if (eventName === 'error') {
      const code = asString(parsed.code);
      const message = asString(parsed.message, '对话执行失败，请重试。');
      if (code === 'AGENT_UNAVAILABLE') {
        opts.onUnavailable(message);
      } else {
        opts.onError(message);
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const frame of parts) {
        if (frame.trim()) dispatchFrame(frame);
      }
    }
    if (buffer.trim()) {
      dispatchFrame(buffer);
    }
  } catch {
    if (!opts.signal?.aborted) {
      opts.onError('对话流意外中断，请重试。');
    }
  }
}

export interface WorkspaceSettingWritePayload {
  readonly key: string;
  readonly value: unknown;
  readonly confirmation_text: string;
}

export interface WorkspaceSettingWriteResponse {
  readonly action: string;
  readonly version_no: number;
  readonly key: string;
  readonly value: unknown;
  readonly updated_by_actor_id: string;
}

export async function postWorkspaceSettingWrite(
  sid: string,
  payload: WorkspaceSettingWritePayload,
): Promise<WorkspaceSettingWriteResponse> {
  const res = await fetch('/recruitment/api/action/settings/write', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-recruitment-request': '1',
      'X-DSH-Session': sid,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    const detail =
      (typeof parsed.detail === 'string' && parsed.detail) ||
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof parsed.title === 'string' && parsed.title) ||
      `保存失败（HTTP ${res.status}）`;
    throw new Error(detail);
  }
  return parsed as unknown as WorkspaceSettingWriteResponse;
}
