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
