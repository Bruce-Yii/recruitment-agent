// 招聘工作区（W2b）**客户端数据层**：只读投影 GET + 写动作 POST（body 由 `actions.ts` 的 build* 产出）。
//
// 与渲染分离：本文件负责"取数 / 取消 / 错误归一化 / 发送前自检 / 重新 GET"，组件只负责渲染视图模型。
// 硬约束：
//   · 只从 props/形参拿 sessionId/alias，**不读 localStorage**；本文件不碰存储；
//   · 每个请求都带 `x-recruitment-request: 1` + `cache:'no-store'`；写请求另带 `x-dsh-session`（**只来自形参**）；
//   · 非 2xx 的 `{error:{code,reason_code,message}}` 原样保留（status/code/reason_code/message/rawBody），
//     界面显示服务端原文，**不把失败说成空数据**；
//   · 写动作：动作不可用 / seam 非同源 / body 含身份派生键 / 缺 session → 客户端**拒绝发请求**；
//     成功事实**只认**响应信封 `readback` + 调用方随后 `reload()` 重新 GET，禁止用本地状态当成功；
//   · 路由探测一律 **GET 同路径**（405=已注册 POST / 404=未接线 / 403=同源问题），**不许** POST 空 body 探测。
//
// 契约出处：`work/d5/actions/CONTRACT.md`、`work/d5/w2b/INTERFACE.md` §2.2、`work/d5/w2b/INTERFACE2.md` §1/§3、
// `work/d5/decision/CONTRACT.md`、`work/d5/joblife/CONTRACT.md` §1、`work/d5/joblife/CONTRACT-ACTIONS.md`。
//
// 出参类型只 `import type` 引用宿主契约（`src/http/recruiting.ts`）。这类 import 在构建时被擦除，
// 不会把 `node:http` / `pg` 拉进浏览器产物（`work/d5/w2/ui/build` 的验证会 grep 这一点）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ApplicationDetailResponse,
  JobDetailResponse,
  RecruitingOverview,
} from '../../http/recruiting.ts'
import {
  ACTION_RESERVED_BODY_KEYS,
  DECISION_EVALUATE_PATH,
  DECISION_FACTS_PATH,
  DECISION_RECORD_PATH,
  JOB_CLOSE_PATH,
  JOB_CREATE_PATH,
  JOB_DRAFT_PATH,
  checkActionRequest,
  checkWriteRequest,
  interpretCloseProbe,
  interpretRouteProbe,
  normalizeDecisionFacts,
  parseActionEnvelope,
  parseActionPayload,
} from './actions.ts'
import type {
  ActionEnvelope,
  ActionOutcome,
  BodyBuildResult,
  CloseSeamProbe,
  CloseSeamState,
  DecisionFacts,
  JobCloseEnvelope,
  RouteProbeState,
  WriteRequestCheck,
} from './actions.ts'
import {
  normalizeApplicationDetail,
  normalizeJobDetail,
  normalizeOverviewView,
  type ActionView,
  type ApplicationDetailView,
  type JobDetailView,
  type RecruitingOverviewView,
} from './view-model.ts'

// 端点常量与纯探测函数从 actions.ts re-export（A 的契约面；B 可直接 import）。
export {
  ACTION_RESERVED_BODY_KEYS,
  DECISION_EVALUATE_PATH,
  DECISION_FACTS_PATH,
  DECISION_RECORD_PATH,
  JOB_CLOSE_PATH,
  JOB_CREATE_PATH,
  JOB_DRAFT_PATH,
  interpretCloseProbe,
  interpretRouteProbe,
}
export type {
  ActionEnvelope,
  ActionOutcome,
  CloseSeamProbe,
  CloseSeamState,
  DecisionFacts,
  JobCloseEnvelope,
  RouteProbeState,
}

/** 只读路由前缀（独立前缀，见 `src/http/recruiting.ts`）。 */
export const RECRUITING_API_PREFIX = '/recruitment/api/recruiting'
/** 同源标记头：宿主只放行带 `x-recruitment-request: 1` 的请求。 */
export const RECRUITING_REQUEST_HEADER = 'x-recruitment-request'
/** 身份头：写动作的身份**只**来自当前 DSH session（值由宿主 props 传入，不读 localStorage）。 */
export const RECRUITING_SESSION_HEADER = 'x-dsh-session'
/** 允许的写动作 seam 前缀（同源相对路径，防跨源/开放跳转）。 */
const WRITE_PATH_PREFIX = '/recruitment/'

/** 归一化后的服务端错误（契约字段原样保留，供界面显示原文）。 */
export interface RecruitingErrorInfo {
  /** HTTP 状态码（网络失败为 0）。 */
  readonly status: number
  /** 契约 `error.code`；解析不到为 ''。 */
  readonly code: string
  /** 契约 `error.reason_code`；解析不到为 ''。 */
  readonly reasonCode: string
  /** 给人看的错误文案（`code/reason_code：message`）。 */
  readonly message: string
  /** 响应体原文（截断到 2000 字符）——界面显示"服务端原文"用。 */
  readonly rawBody: string
}

/** 带契约字段的客户端请求错误。 */
export class RecruitingRequestError extends Error {
  readonly info: RecruitingErrorInfo

  constructor(info: RecruitingErrorInfo) {
    super(info.message)
    this.name = 'RecruitingRequestError'
    this.info = info
  }
}

/** 把任意异常归一化成 `RecruitingErrorInfo`（网络异常 → status 0 / code NETWORK）。 */
export function toRecruitingErrorInfo(failure: unknown): RecruitingErrorInfo {
  if (failure instanceof RecruitingRequestError) return failure.info
  const message = failure instanceof Error ? failure.message : String(failure)
  return { status: 0, code: 'NETWORK', reasonCode: '', message: `请求失败：${message}`, rawBody: '' }
}

/** 解析非 2xx 响应体（保留 code / reason_code / message 原文）。 */
export function parseRecruitingError(status: number, rawBody: string): RecruitingErrorInfo {
  const body = rawBody.trim()
  let parsed: unknown = undefined
  if (body !== '') {
    try {
      parsed = JSON.parse(body) as unknown
    } catch {
      parsed = undefined
    }
  }
  const errorRaw =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).error
      : undefined
  const errorRecord =
    errorRaw !== null && typeof errorRaw === 'object' && !Array.isArray(errorRaw)
      ? (errorRaw as Record<string, unknown>)
      : {}
  const code = typeof errorRecord.code === 'string' ? errorRecord.code : ''
  const reasonCode = typeof errorRecord.reason_code === 'string' ? errorRecord.reason_code : ''
  const serverMessage =
    typeof errorRecord.message === 'string'
      ? errorRecord.message
      : typeof errorRaw === 'string'
        ? errorRaw
        : ''
  const prefix = [code, reasonCode].filter((part) => part !== '').join('/')
  const message =
    serverMessage !== ''
      ? `${prefix === '' ? '' : `${prefix}：`}${serverMessage}`
      : `宿主返回 HTTP ${String(status)}${body === '' ? '' : `：${body.slice(0, 200)}`}`
  return { status, code, reasonCode, message, rawBody: body.slice(0, 2000) }
}

/** 一次 HTTP 响应（保留原文，便于错误归一化）。 */
interface RawResponse {
  readonly ok: boolean
  readonly status: number
  readonly bodyText: string
}

/** 只读 GET 的公共头（同源标记）。 */
function readHeaders(): Record<string, string> {
  return { [RECRUITING_REQUEST_HEADER]: '1' }
}

/** 写请求的公共头（同源标记 + JSON + session；session 只来自形参）。 */
function writeHeaders(sessionId: string): Record<string, string> {
  return {
    [RECRUITING_REQUEST_HEADER]: '1',
    'content-type': 'application/json',
    [RECRUITING_SESSION_HEADER]: sessionId.trim(),
  }
}

/** 统一请求：网络异常转可读错误；非 2xx 转 `RecruitingRequestError`。 */
async function requestRaw(url: string, init: RequestInit, signal?: AbortSignal): Promise<RawResponse> {
  let response: Response
  try {
    response = await fetch(url, {
      cache: 'no-store',
      ...init,
      ...(signal !== undefined ? { signal } : {}),
      headers: { ...readHeaders(), ...init.headers },
    })
  } catch (failure: unknown) {
    if (signal?.aborted === true) throw failure
    const message = failure instanceof Error ? failure.message : String(failure)
    throw new RecruitingRequestError({ status: 0, code: 'NETWORK', reasonCode: '', message: `网络请求失败：${message}`, rawBody: '' })
  }
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }
  if (!response.ok) throw new RecruitingRequestError(parseRecruitingError(response.status, bodyText))
  return { ok: true, status: response.status, bodyText }
}

/**
 * GET 一个 JSON 契约响应（**类型只用于编译期**；运行时形状由视图模型兜底归一化）。
 * @param url - 同源相对路径。
 * @param signal - 取消信号。
 * @returns 解析后的原始 JSON（空体/非 JSON 抛 `BAD_RESPONSE`）。
 */
async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const raw = await requestRaw(url, { method: 'GET' }, signal)
  const body = raw.bodyText.trim()
  if (body === '') {
    throw new RecruitingRequestError({ status: raw.status, code: 'BAD_RESPONSE', reasonCode: '', message: '宿主返回了空响应体', rawBody: '' })
  }
  try {
    return JSON.parse(body) as T
  } catch {
    throw new RecruitingRequestError({
      status: raw.status,
      code: 'BAD_RESPONSE',
      reasonCode: '',
      message: '宿主返回的不是 JSON',
      rawBody: body.slice(0, 2000),
    })
  }
}

/** 读取 `GET /recruitment/api/recruiting/overview` 并归一化成视图模型。 */
export async function fetchOverviewView(signal?: AbortSignal): Promise<RecruitingOverviewView> {
  const wire = await requestJson<RecruitingOverview>(`${RECRUITING_API_PREFIX}/overview`, signal)
  return normalizeOverviewView(wire)
}

/** 读取 `GET /recruitment/api/recruiting/applications/:id` 并归一化成视图模型。 */
export async function fetchApplicationDetail(applicationId: string, signal?: AbortSignal): Promise<ApplicationDetailView> {
  const id = applicationId.trim()
  if (id === '') {
    throw new RecruitingRequestError({ status: 0, code: 'INVALID_ARGS', reasonCode: 'ID_MISSING', message: '申请 id 为空，拒绝请求', rawBody: '' })
  }
  const wire = await requestJson<ApplicationDetailResponse>(
    `${RECRUITING_API_PREFIX}/applications/${encodeURIComponent(id)}`,
    signal,
  )
  return normalizeApplicationDetail(wire)
}

/** 读取 `GET /recruitment/api/recruiting/jobs/:id` 并归一化成视图模型。 */
export async function fetchJobDetail(jobId: string, signal?: AbortSignal): Promise<JobDetailView> {
  const id = jobId.trim()
  if (id === '') {
    throw new RecruitingRequestError({ status: 0, code: 'INVALID_ARGS', reasonCode: 'ID_MISSING', message: '岗位 id 为空，拒绝请求', rawBody: '' })
  }
  const wire = await requestJson<JobDetailResponse>(
    `${RECRUITING_API_PREFIX}/jobs/${encodeURIComponent(id)}`,
    signal,
  )
  return normalizeJobDetail(wire)
}

/** 一个异步资源的取数状态。 */
export interface AsyncResource<T> {
  /** 归一化后的数据；未取到 / 失败时为 undefined。 */
  readonly data: T | undefined
  /** 归一化后的错误；成功时为 undefined。 */
  readonly error: RecruitingErrorInfo | undefined
  /** 是否正在读取。 */
  readonly loading: boolean
  /** 重新从服务端 GET（不是本地重算）。 */
  readonly reload: () => void
  /** 重新读取的代数（组件用它做 key / 依赖）。 */
  readonly generation: number
}

/**
 * 通用取数 hook：KEY 变化或 `reload()` 时重新 GET；卸载 / KEY 变化时取消在途请求。
 * @param key - 资源键（null = 不请求）。
 * @param loader - 真正的取数函数（可被替换而不触发重取）。
 * @returns 数据 / 错误 / 加载中 / 重取。
 */
function useResource<T>(key: string | null, loader: (signal: AbortSignal) => Promise<T>): AsyncResource<T> {
  const [generation, setGeneration] = useState(0)
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<RecruitingErrorInfo | undefined>(undefined)
  const [loading, setLoading] = useState<boolean>(key !== null)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const reload = useCallback(() => {
    setGeneration((value) => value + 1)
  }, [])

  useEffect(() => {
    if (key === null) {
      setData(undefined)
      setError(undefined)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError(undefined)
    loaderRef
      .current(controller.signal)
      .then((value) => {
        if (!active) return
        setData(value)
        setLoading(false)
      })
      .catch((failure: unknown) => {
        if (!active || controller.signal.aborted) return
        setData(undefined)
        setError(toRecruitingErrorInfo(failure))
        setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [key, generation])

  return { data, error, loading, reload, generation }
}

/** 工作区总览（岗位 / 申请 / 设置 / 动作可用性）。 */
export function useWorkspaceOverview(): AsyncResource<RecruitingOverviewView> {
  return useResource<RecruitingOverviewView>('overview', (signal) => fetchOverviewView(signal))
}

/** 单个申请详情（id 为空串时不请求）。 */
export function useApplicationDetail(applicationId: string): AsyncResource<ApplicationDetailView> {
  const key = applicationId.trim() === '' ? null : `application:${applicationId.trim()}`
  return useResource<ApplicationDetailView>(key, (signal) => fetchApplicationDetail(applicationId, signal))
}

/** 单个岗位详情（id 为空串时不请求）。 */
export function useJobDetail(jobId: string): AsyncResource<JobDetailView> {
  const key = jobId.trim() === '' ? null : `job:${jobId.trim()}`
  return useResource<JobDetailView>(key, (signal) => fetchJobDetail(jobId, signal))
}

// =====================================================================
//  写动作 POST（body 必须由 actions.ts 的 build* 产出；成功只认信封 readback）
// =====================================================================

/** 发送前拒绝 → `ActionOutcome`（status 0，不发请求）。 */
function refusedOutcome(key: string, check: Extract<WriteRequestCheck, { ok: false }>): ActionOutcome {
  return {
    key,
    accepted: false,
    status: 0,
    envelope: null,
    error: {
      status: 0,
      code: check.code,
      reasonCode: check.reasonCode,
      message: `${check.reasonText}（reason_code：${check.reasonCode}）`,
      rawBody: '',
    },
    bodyText: '',
    payload: null,
  }
}

/**
 * POST 一个写路径（body 已由 build* 产出）；成功只解析信封，**不**在这里判定业务成功。
 * @param path - 同源相对路径。
 * @param body - build* 产出的 body。
 * @param sessionId - 宿主 props 传入的 session id（只从形参来）。
 * @param key - 动作键（结果里回显）。
 * @returns 受理状态 / 信封 / 服务端错误原文。
 */
async function postWrite(
  path: string,
  body: Readonly<Record<string, unknown>>,
  sessionId: string,
  key: string,
  signal?: AbortSignal,
): Promise<ActionOutcome> {
  const check = checkWriteRequest(path, body, sessionId)
  if (!check.ok) return refusedOutcome(key, check)
  try {
    const raw = await requestRaw(
      path,
      { method: 'POST', headers: writeHeaders(sessionId), body: JSON.stringify(body) },
      signal,
    )
    return {
      key,
      accepted: true,
      status: raw.status,
      envelope: parseActionEnvelope(raw.bodyText),
      error: null,
      bodyText: raw.bodyText.slice(0, 2000),
      payload: parseActionPayload(raw.bodyText),
    }
  } catch (failure: unknown) {
    if (failure instanceof RecruitingRequestError) {
      return {
        key,
        accepted: false,
        status: failure.info.status,
        envelope: null,
        error: failure.info,
        bodyText: failure.info.rawBody,
        payload: parseActionPayload(failure.info.rawBody),
      }
    }
    const info = toRecruitingErrorInfo(failure)
    return { key, accepted: false, status: 0, envelope: null, error: info, bodyText: '', payload: null }
  }
}

/**
 * POST 后端 action seam（JSON + `x-recruitment-request: 1` + `x-dsh-session`）。
 *
 * 安全口径：`action.available !== true` / seam 非 `/recruitment/` 同源相对路径 / body 含身份派生键 /
 * 缺 sessionId → **不发请求**，返回 `CLIENT_REFUSED`；2xx 只算"服务端受理"，调用方必须随后 `reload()`。
 * @param action - 归一化后的写动作（来自 `overview.actions` / 详情 `actions`）。
 * @param body - 由 `actions.ts` 的 `build*` 产出的 body（**不再固定发 {}**）。
 * @param sessionId - 当前 DSH session id（只来自形参）。
 * @returns `ActionOutcome`（信封 readback + 服务端错误原文）。
 */
export async function postActionSeam(
  action: ActionView,
  body: Readonly<Record<string, unknown>>,
  sessionId: string,
): Promise<ActionOutcome> {
  const check = checkActionRequest(action, body, sessionId)
  if (!check.ok) return refusedOutcome(action.key, check)
  return postWrite(action.seam, body, sessionId, action.key)
}

/**
 * 岗位关闭：内部固定 body `{job_id, confirm:true, reason?}`（`confirm:true` 是人的裁决）。
 * 调用方只在用户点"确认关闭"后调用；成功信封用 `parseJobCloseEnvelope(outcome.bodyText)` 解析。
 * @param jobId - 岗位 id。
 * @param reason - 可选关闭原因（≤500）。
 * @param sessionId - 当前 DSH session id（只来自形参）。
 */
export async function postJobClose(jobId: string, reason: string, sessionId: string): Promise<ActionOutcome> {
  const id = jobId.trim()
  const trimmedReason = reason.trim()
  if (id === '') {
    return refusedOutcome('job_close', {
      ok: false,
      status: 0,
      code: 'CLIENT_REFUSED',
      reasonCode: 'JOB_ID_INVALID',
      reasonText: '岗位 id 为空，拒绝关闭请求',
      missing: ['job_id'],
    })
  }
  const body: Record<string, unknown> = { job_id: id, confirm: true }
  if (trimmedReason !== '') body.reason = trimmedReason
  return postWrite(JOB_CLOSE_PATH, body, sessionId, 'job_close')
}

/**
 * GET 同路径探测岗位关闭路由（零写入；405 = 已注册 POST 路由，404 = 未接线，403 = 同源问题）。
 * @param sessionId - 当前 DSH session id（带上是让同源/身份闸门按真实情况回答）。
 * @param signal - 取消信号。
 */
export async function probeJobCloseSeam(sessionId: string, signal?: AbortSignal): Promise<CloseSeamProbe> {
  let status = 0
  try {
    const response = await fetch(JOB_CLOSE_PATH, {
      method: 'GET',
      cache: 'no-store',
      ...(signal !== undefined ? { signal } : {}),
      headers: writeHeaders(sessionId),
    })
    status = response.status
    try {
      await response.text()
    } catch {
      // 探测只关心状态码；响应体读失败不影响结论。
    }
  } catch {
    status = 0
  }
  return interpretCloseProbe(status)
}

/**
 * 岗位关闭 seam 探测 hook（只在启用时探测；卸载/重新探测时取消在途请求）。
 * @param sessionId - 当前 DSH session id。
 * @param enabled - 是否探测（例如只有 Recruiter 视图才需要）。
 */
export function useJobCloseSeam(
  sessionId: string,
  enabled: boolean,
): {
  readonly probe: CloseSeamProbe | undefined
  readonly loading: boolean
  readonly refresh: () => void
} {
  const [probe, setProbe] = useState<CloseSeamProbe | undefined>(undefined)
  const [loading, setLoading] = useState<boolean>(false)
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => {
    setGeneration((value) => value + 1)
  }, [])
  useEffect(() => {
    if (!enabled) {
      setProbe(undefined)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let active = true
    setLoading(true)
    probeJobCloseSeam(sessionId, controller.signal)
      .then((value) => {
        if (!active) return
        setProbe(value)
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setProbe(interpretCloseProbe(0))
        setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [enabled, sessionId, generation])
  return { probe, loading, refresh }
}

/**
 * 执行初筛评估 `POST /recruitment/api/decision/screening/evaluate`（body 只有 application_id）。
 * 成功信封不是标准 action 信封：用 `outcome.payload.evaluation/.readback` 显示；随后重新 GET facts。
 * @param applicationId - 申请 id。
 * @param sessionId - 当前 DSH session id（只来自形参）。
 */
export async function postScreeningEvaluate(applicationId: string, sessionId: string): Promise<ActionOutcome> {
  const id = applicationId.trim()
  if (id === '') {
    return refusedOutcome('screening_evaluate', {
      ok: false,
      status: 0,
      code: 'CLIENT_REFUSED',
      reasonCode: 'MISSING_APPLICATION_ID',
      reasonText: '申请 id 为空，拒绝初筛评估请求',
      missing: ['application_id'],
    })
  }
  return postWrite(DECISION_EVALUATE_PATH, { application_id: id }, sessionId, 'screening_evaluate')
}

/**
 * 正式决策 facade `POST /recruitment/api/decision/record`（body 必须由 `buildDecisionRecordBody` 产出；
 * 前端不传 summary_digest / basis_refs —— facade 自己从 facts 组装）。
 * @param body - `buildDecisionRecordBody` 产出的 body。
 * @param sessionId - 当前 DSH session id（只来自形参）。
 */
export async function postDecisionRecordFacade(
  body: Readonly<Record<string, unknown>>,
  sessionId: string,
): Promise<ActionOutcome> {
  return postWrite(DECISION_RECORD_PATH, body, sessionId, 'decision_record_facade')
}

/**
 * 岗位草案 `POST /recruitment/api/job-action/job/draft`（body 由 `buildJobDraftBody` 产出；只读不写库）。
 * @param body - `buildJobDraftBody` 产出的 body。
 * @param sessionId - 当前 DSH session id（只来自形参）。
 */
export async function postJobDraft(
  body: Readonly<Record<string, unknown>>,
  sessionId: string,
): Promise<ActionOutcome> {
  return postWrite(JOB_DRAFT_PATH, body, sessionId, 'job_draft')
}

/**
 * 岗位创建 `POST /recruitment/api/job-action/job/create`（body 由 `buildJobCreateBody` 产出；人确认后才调用）。
 * @param body - `buildJobCreateBody` 产出的 body。
 * @param sessionId - 当前 DSH session id（只来自形参）。
 */
export async function postJobCreate(
  body: Readonly<Record<string, unknown>>,
  sessionId: string,
): Promise<ActionOutcome> {
  return postWrite(JOB_CREATE_PATH, body, sessionId, 'job_create')
}

// =====================================================================
//  路由探测 hook（GET 同路径；零写入）
// =====================================================================

/**
 * GET 同路径探测一个写路由是否已注册（405 = 已注册 POST 路由 / 404 = 未接线 / 403 = 同源问题）。
 *
 * **不许**用 POST 空 body 探测（会打日志、可能触发闸门）。
 * @param path - 写路由路径（`/recruitment/...`）。
 * @param sessionId - 当前 DSH session id。
 * @param enabled - 是否探测。
 */
export function useRouteProbe(
  path: string,
  sessionId: string,
  enabled: boolean,
): {
  readonly state: RouteProbeState
  readonly status: number
  readonly loading: boolean
  readonly refresh: () => void
} {
  const [state, setState] = useState<RouteProbeState>('UNKNOWN')
  const [status, setStatus] = useState(0)
  const [loading, setLoading] = useState(false)
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => {
    setGeneration((value) => value + 1)
  }, [])
  useEffect(() => {
    if (!enabled || path === '') {
      setState('UNKNOWN')
      setStatus(0)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let active = true
    setLoading(true)
    const headers: Record<string, string> = { [RECRUITING_REQUEST_HEADER]: '1' }
    if (sessionId.trim() !== '') headers[RECRUITING_SESSION_HEADER] = sessionId.trim()
    fetch(path, { method: 'GET', cache: 'no-store', signal: controller.signal, headers })
      .then(async (response) => {
        const next = interpretRouteProbe(response.status)
        try {
          await response.text()
        } catch {
          // 只关心状态码。
        }
        if (!active) return
        setState(next)
        setStatus(response.status)
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setState('UNKNOWN')
        setStatus(0)
        setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [path, sessionId, enabled, generation])
  return { state, status, loading, refresh }
}

// =====================================================================
//  决策事实只读投影（GET /recruitment/api/decision/facts）
// =====================================================================

/** facts 取数状态：`READY` 可用 / `MISSING` 路由未接线(404) / `ERROR` 其它失败 / `LOADING` 读取中。 */
export type DecisionFactsProbe = 'READY' | 'MISSING' | 'ERROR' | 'LOADING'

/** 一次 facts 取数的结果（404 不当空 facts：`facts` 为 undefined 且 probe=MISSING）。 */
export interface DecisionFactsResource {
  readonly facts: DecisionFacts | undefined
  readonly probe: DecisionFactsProbe
  readonly error: RecruitingErrorInfo | undefined
  readonly status: number
}

/**
 * 读取决策事实投影 `GET /recruitment/api/decision/facts?application_id=<uuid>`。
 *
 * 404 / 非 2xx **不**当空 facts：`facts` 保持 undefined，probe 区分 MISSING(404) / ERROR(其它)。
 * @param applicationId - 申请 id。
 * @param sessionId - 当前 DSH session id（空串 = 不带该头，由服务端决定是否 400）。
 * @param signal - 取消信号。
 */
export async function fetchDecisionFacts(
  applicationId: string,
  sessionId = '',
  signal?: AbortSignal,
): Promise<DecisionFactsResource> {
  const id = applicationId.trim()
  if (id === '') {
    return {
      facts: undefined,
      probe: 'MISSING',
      status: 0,
      error: { status: 0, code: 'CLIENT_REFUSED', reasonCode: 'MISSING_APPLICATION_ID', message: '申请 id 为空，拒绝读取决策事实', rawBody: '' },
    }
  }
  const headers: Record<string, string> = { [RECRUITING_REQUEST_HEADER]: '1' }
  if (sessionId.trim() !== '') headers[RECRUITING_SESSION_HEADER] = sessionId.trim()
  const url = `${DECISION_FACTS_PATH}?application_id=${encodeURIComponent(id)}`
  let status = 0
  let bodyText = ''
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      ...(signal !== undefined ? { signal } : {}),
      headers,
    })
    status = response.status
    try {
      bodyText = await response.text()
    } catch {
      bodyText = ''
    }
  } catch (failure: unknown) {
    if (signal?.aborted === true) throw failure
    return {
      facts: undefined,
      probe: 'ERROR',
      status: 0,
      error: toRecruitingErrorInfo(failure),
    }
  }
  if (status === 404) {
    return {
      facts: undefined,
      probe: 'MISSING',
      status,
      error: parseRecruitingError(status, bodyText),
    }
  }
  if (status < 200 || status >= 300) {
    return { facts: undefined, probe: 'ERROR', status, error: parseRecruitingError(status, bodyText) }
  }
  const payload = parseActionPayload(bodyText)
  const facts = normalizeDecisionFacts(payload)
  if (facts === null) {
    return {
      facts: undefined,
      probe: 'ERROR',
      status,
      error: {
        status,
        code: 'BAD_RESPONSE',
        reasonCode: '',
        message: '决策事实投影响应无法归一化（缺 application_id 或不是 JSON 对象）',
        rawBody: bodyText.slice(0, 2000),
      },
    }
  }
  return { facts, probe: 'READY', status, error: undefined }
}

/**
 * 决策事实 hook（facts 路由 404 → probe=MISSING，表单 disabled；成功 → READY + facts）。
 * @param applicationId - 申请 id。
 * @param enabled - 是否读取（例如详情已加载且是 Recruiter 视图）。
 * @param sessionId - 当前 DSH session id（**写动作身份只来自宿主 props**，不读 localStorage）。
 */
export function useDecisionFacts(
  applicationId: string,
  enabled: boolean,
  sessionId = '',
): {
  readonly facts: DecisionFacts | undefined
  readonly probe: DecisionFactsProbe
  readonly error: RecruitingErrorInfo | undefined
  readonly reload: () => void
} {
  const id = applicationId.trim()
  const [resource, setResource] = useState<DecisionFactsResource>({
    facts: undefined,
    probe: 'LOADING',
    error: undefined,
    status: 0,
  })
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => {
    setGeneration((value) => value + 1)
  }, [])
  useEffect(() => {
    if (!enabled || id === '') {
      setResource({ facts: undefined, probe: 'MISSING', error: undefined, status: 0 })
      return
    }
    if (sessionId.trim() === '') {
      // 没有宿主 session 就不发请求：这是客户端缺参数，不是"路由未接线"。
      setResource({
        facts: undefined,
        probe: 'ERROR',
        status: 0,
        error: {
          status: 0,
          code: 'CLIENT_REFUSED',
          reasonCode: 'SESSION_MISSING',
          message: '还没有识别到当前身份，客户端不会读取决策所需信息',
          rawBody: '',
        },
      })
      return
    }
    const controller = new AbortController()
    let active = true
    setResource({ facts: undefined, probe: 'LOADING', error: undefined, status: 0 })
    fetchDecisionFacts(id, sessionId, controller.signal)
      .then((value) => {
        if (!active) return
        setResource(value)
      })
      .catch((failure: unknown) => {
        if (!active) return
        setResource({ facts: undefined, probe: 'ERROR', status: 0, error: toRecruitingErrorInfo(failure) })
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [id, enabled, sessionId, generation])
  return { facts: resource.facts, probe: resource.probe, error: resource.error, reload }
}

/** 写动作的本地前置校验结果（组件在 onRunAction 前展示 `reasonCode`；不发请求）。 */
export type { BodyBuildResult }
