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

/**
 * 统一请求封装：网络错误 / 非 2xx / 坏 JSON 都变成可读错误。
 * @param url - 同源相对路径。
 * @param sessionId - DSH session id（服务端用它解析绑定的演示身份）。
 * @param init - fetch 参数（方法/头/体/signal）。
 * @returns 解析后的 JSON（空体为 undefined）。
 * @throws {RecruitmentHttpError} 网络失败（status 0）或非 2xx（保留契约字段）。
 */
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

/**
 * 读取一次面试官工作台投影（`GET /recruitment/api/interviewer/overview`）。
 *
 * 缺 session / alias 时**不发请求**（fail-closed）：没有身份就没有"我的分配"，
 * 发出去只会让服务端返 403/409，还会把界面引到错误分支。
 * @param options - sessionId / alias / 可选 interviewId / signal。
 * @returns 归一化后的 overview。
 * @throws {RecruitmentHttpError} `SESSION_HEADER_REQUIRED`（本地拦截）或服务端错误。
 */
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

/**
 * 读取 W1 面评表单 spec（含一次性 nonce）。
 * @param options - sessionId / interviewId / 可选 applicationId / signal。
 * @returns 归一化后的 form spec（维度键只来自服务端）。
 * @throws {RecruitmentHttpError} W1 未就绪时 status 为 404/405/501 或 0。
 */
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

/**
 * 提交本人面评（`POST /recruitment/api/action/scorecard/submit`）。
 *
 * 提交体由 `buildScorecardSubmitBody` 构造（维度键只来自 form spec）；
 * 成功只认 2xx + 服务端 DB 读回，**没有**任何本地"假成功"。
 * @param options - sessionId + 已构造好的提交体。
 * @returns 归一化后的 DB 读回。
 * @throws {RecruitmentHttpError} 403/409（NONCE_*、ALREADY_SUBMITTED…）或其它非 2xx。
 */
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

/**
 * 判断错误是否表示"W1 面评提交入口尚未就绪"（契约 §2.3：404/405/网络错）。
 *
 * 为什么把 501 也算进去：宿主/隧道对未实现路由有两种常见回答（405/404 与 501）；
 * 只要不是服务端业务拒绝（400/403/409），界面就应显示"未就绪"而不是"提交失败"。
 * @param failure - 捕获到的任意错误。
 * @returns true 表示应按"入口未就绪（W1）"降级。
 */
export function isScorecardEndpointUnavailable(failure: unknown): boolean {
  if (!(failure instanceof RecruitmentHttpError)) return false
  return failure.status === 0 || failure.status === 404 || failure.status === 405 || failure.status === 501
}

export const SCORECARD_DRAFT_STORAGE_PREFIX = 'ros-iw-draft-'

export function readLocalScorecardDraft(interviewId: string): ScorecardDraftPayload | null {
  try {
    const raw = window.localStorage.getItem(SCORECARD_DRAFT_STORAGE_PREFIX + interviewId)
    if (!raw) return null
    return normalizeScorecardDraft(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeLocalScorecardDraft(interviewId: string, payload: ScorecardDraftPayload): void {
  try {
    window.localStorage.setItem(SCORECARD_DRAFT_STORAGE_PREFIX + interviewId, JSON.stringify(payload))
  } catch {
    // ignore storage quota errors
  }
}

export function clearLocalScorecardDraft(interviewId: string): void {
  try {
    window.localStorage.removeItem(SCORECARD_DRAFT_STORAGE_PREFIX + interviewId)
  } catch {
    // ignore
  }
}

/**
 * 读取服务端面评草稿（GET /recruitment/api/action/scorecard/draft?interview_id=...）。
 * 404/未就绪返回 null，不崩页面；调用方据此决定是否回退 localStorage 断网兜底。
 */
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

/**
 * 自动保存面评草稿（POST /recruitment/api/action/scorecard/draft）。
 * 严禁携带 confirmation_text（草稿不是最终判断，见 Task 06 T6-2）。
 */
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

/** 提交面评成功后清理服务端与本地草稿。 */
export async function clearScorecardDraft(options: {
  readonly sessionId: string
  readonly interviewId: string
}): Promise<void> {
  clearLocalScorecardDraft(options.interviewId)
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
