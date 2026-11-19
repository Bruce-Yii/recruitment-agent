// Interviewer Workspace 的 HTTP 数据层：只调宿主同源路由，绝不直连数据库。
//
// 三条请求（全部 `credentials: 'same-origin'` + `x-recruitment-request: 1` + `X-DSH-Session`）：
//   1. `GET /recruitment/api/interviewer/overview?alias=…`         —— W3 读模型（我的分配）
//   2. `GET /recruitment/api/action/scorecard/form?interview_id=…` —— W1 表单 spec + 一次性 nonce
//   3. `POST /recruitment/api/action/scorecard/submit`             —— W1 提交（服务端事务写入）
//
// 为什么把 fetch 收在这里：渲染层只拿"归一化后的安全形状"或一个带契约字段的错误，
// 界面代码里不会出现裸 fetch / 手写 JSON.parse。非 2xx 一律转成 `RecruitmentHttpError`
// （保留 status / code / reason_code / detail），W1 端点未就绪（404/405/网络错）由
// `isScorecardEndpointUnavailable` 统一识别，界面据此禁用按钮而不是假装成功。

import {
  normalizeInterviewerOverview,
  normalizeScorecardFormSpec,
  normalizeScorecardDraft,
  normalizeSubmitResult,
  parseHttpError,
  RecruitmentHttpError,
  type InterviewerOverview,
  type ScorecardDraftPayload,
  type ScorecardFormSpec,
  type ScorecardSubmitBody,
  type ScorecardSubmitResult,
} from './normalize.ts'

/** 宿主只读路由（同源相对路径）。 */
const OVERVIEW_ENDPOINT = '/recruitment/api/interviewer/overview'
/** W1 表单 spec / 提交路由。 */
const SCORECARD_FORM_ENDPOINT = '/recruitment/api/action/scorecard/form'
const SCORECARD_SUBMIT_ENDPOINT = '/recruitment/api/action/scorecard/submit'
const SCORECARD_DRAFT_ENDPOINT = '/recruitment/api/action/scorecard/draft'
/** 同源标记头（宿主侧 `x-recruitment-request: 1` 才放行）。 */
const REQUEST_HEADER = 'x-recruitment-request'
/** 服务端唯一接受的 session 身份头（值只来自 props，不读 localStorage）。 */
const SESSION_HEADER = 'X-DSH-Session'

/** `fetchInterviewerOverview` 的入参。 */
export interface FetchOverviewOptions {
  readonly sessionId: string
  readonly alias: string
  /** 可选：只读单场面试（服务端仍按"我的分配"过滤，未分配 403）。 */
  readonly interviewId?: string
  readonly signal?: AbortSignal
}

/** `fetchScorecardFormSpec` 的入参。 */
export interface FetchFormSpecOptions {
  readonly sessionId: string
  readonly interviewId: string
  /** 可选：W1 nonce 绑定 session+interview+application，有就带上。 */
  readonly applicationId?: string
  /**
   * 可选：申请钉住的 rubric 版本 id（来自 overview 行的 `rubric.rubric_version_id`）。
   * W1 的 form 端点允许 `rubric_version_id` 查询参数；申请没钉住版本时**不猜**（该行为 null）。
   */
  readonly rubricVersionId?: string
  readonly signal?: AbortSignal
}

/** `submitScorecard` 的入参。 */
export interface SubmitScorecardOptions {
  readonly sessionId: string
  readonly body: ScorecardSubmitBody
}

async function requestJson(url: string, sessionId: string, init: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = {
    [REQUEST_HEADER]: '1',
    [SESSION_HEADER]: sessionId,
  }
  if (init.headers !== undefined) {
    for (const [key, value] of Object.entries(init.headers as Record<string, string>)) headers[key] = value
  }
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch (failure: unknown) {
    throw new RecruitmentHttpError(
      0,
      'NETWORK_ERROR',
      'NETWORK_UNREACHABLE',
      `网络请求失败：${failure instanceof Error ? failure.message : String(failure)}`,
      undefined,
    )
  }
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  if (!response.ok) throw parseHttpError(response.status, text)
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RecruitmentHttpError(response.status, 'INVALID_RESPONSE', 'NOT_JSON', '宿主返回的不是 JSON', undefined)
  }
}

export async function fetchInterviewerOverview(options: FetchOverviewOptions): Promise<InterviewerOverview> {
  const sessionId = options.sessionId.trim()
  const alias = options.alias.trim()
  if (sessionId === '' || alias === '') {
    throw new RecruitmentHttpError(
      0,
      'DEMO_ACTOR_UNMAPPED',
      'SESSION_NOT_BOUND',
      '当前 Session 尚未绑定演示身份（fail-closed）：请先在顶部选择身份',
      undefined,
    )
  }
  const query = new URLSearchParams({ alias })
  const interviewId = (options.interviewId ?? '').trim()
  if (interviewId !== '') query.set('interview_id', interviewId)
  const value = await requestJson(`${OVERVIEW_ENDPOINT}?${query.toString()}`, sessionId, {
    method: 'GET',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  return normalizeInterviewerOverview(value)
}

export async function fetchScorecardFormSpec(options: FetchFormSpecOptions): Promise<ScorecardFormSpec> {
  const sessionId = options.sessionId.trim()
  const interviewId = options.interviewId.trim()
  if (sessionId === '') {
    throw new RecruitmentHttpError(
      0,
      'DEMO_ACTOR_UNMAPPED',
      'SESSION_NOT_BOUND',
      '当前 Session 尚未绑定演示身份（fail-closed）：请先在顶部选择身份',
      undefined,
    )
  }
  if (interviewId === '') {
    throw new RecruitmentHttpError(0, 'INVALID_ARGS', 'INTERVIEW_ID_REQUIRED', '缺少面试 id，无法读取面评表单', undefined)
  }
  const query = new URLSearchParams({ interview_id: interviewId })
  const applicationId = (options.applicationId ?? '').trim()
  if (applicationId !== '') query.set('application_id', applicationId)
  const rubricVersionId = (options.rubricVersionId ?? '').trim()
  if (rubricVersionId !== '') query.set('rubric_version_id', rubricVersionId)
  const value = await requestJson(`${SCORECARD_FORM_ENDPOINT}?${query.toString()}`, sessionId, {
    method: 'GET',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  return normalizeScorecardFormSpec(value)
}

export async function submitScorecard(options: SubmitScorecardOptions): Promise<ScorecardSubmitResult> {
  const sessionId = options.sessionId.trim()
  if (sessionId === '') {
    throw new RecruitmentHttpError(
      0,
      'DEMO_ACTOR_UNMAPPED',
      'SESSION_NOT_BOUND',
      '当前 Session 尚未绑定演示身份（fail-closed）：请先在顶部选择身份',
      undefined,
    )
  }
  const value = await requestJson(SCORECARD_SUBMIT_ENDPOINT, sessionId, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body),
  })
  return normalizeSubmitResult(value)
}

export function isScorecardEndpointUnavailable(failure: unknown): boolean {
  if (!(failure instanceof RecruitmentHttpError)) return false
  return failure.status === 0 || failure.status === 404 || failure.status === 405 || failure.status === 501
}

export const SCORECARD_DRAFT_STORAGE_PREFIX = 'ros-iw-draft-'

export function readLocalScorecardDraft(interviewId: string, scopeKey = ''): ScorecardDraftPayload | null {
  try {
    const raw = window.localStorage.getItem(`${SCORECARD_DRAFT_STORAGE_PREFIX}${scopeKey}:${interviewId}`)
    if (!raw) return null
    return normalizeScorecardDraft(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeLocalScorecardDraft(interviewId: string, payload: ScorecardDraftPayload, scopeKey = ''): void {
  try {
    window.localStorage.setItem(`${SCORECARD_DRAFT_STORAGE_PREFIX}${scopeKey}:${interviewId}`, JSON.stringify(payload))
  } catch {
    // ignore storage quota errors
  }
}

export function clearLocalScorecardDraft(interviewId: string, scopeKey = ''): void {
  try {
    window.localStorage.removeItem(`${SCORECARD_DRAFT_STORAGE_PREFIX}${scopeKey}:${interviewId}`)
  } catch {
    // ignore
  }
}

export async function fetchScorecardDraft(options: {
  readonly sessionId: string
  readonly interviewId: string
  readonly signal?: AbortSignal
}): Promise<ScorecardDraftPayload | null> {
  const sessionId = options.sessionId.trim()
  if (sessionId === '' || options.interviewId.trim() === '') return null
  try {
    const url = `${SCORECARD_DRAFT_ENDPOINT}?interview_id=${encodeURIComponent(options.interviewId)}`
    const value = await requestJson(url, sessionId, {
      method: 'GET',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    return normalizeScorecardDraft(value)
  } catch {
    return null
  }
}

export async function saveScorecardDraft(options: {
  readonly sessionId: string
  readonly interviewId: string
  readonly payload: ScorecardDraftPayload
}): Promise<boolean> {
  const sessionId = options.sessionId.trim()
  if (sessionId === '' || options.interviewId.trim() === '') return false
  await requestJson(SCORECARD_DRAFT_ENDPOINT, sessionId, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      interview_id: options.interviewId,
      payload: {
        assessments: options.payload.assessments,
        note: options.payload.note,
      },
    }),
  })
  return true
}

export async function clearScorecardDraft(options: {
  readonly sessionId: string
  readonly interviewId: string
  readonly scopeKey?: string
}): Promise<void> {
  clearLocalScorecardDraft(options.interviewId, options.scopeKey ?? options.sessionId)
  const sessionId = options.sessionId.trim()
  if (sessionId === '' || options.interviewId.trim() === '') return
  try {
    await requestJson(
      `${SCORECARD_DRAFT_ENDPOINT}?interview_id=${encodeURIComponent(options.interviewId)}`,
      sessionId,
      { method: 'DELETE' },
    )
  } catch {
    try {
      await requestJson(SCORECARD_DRAFT_ENDPOINT, sessionId, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          interview_id: options.interviewId,
          payload: { assessments: {}, note: '' },
        }),
      })
    } catch {
      // best-effort cleanup
    }
  }
}
