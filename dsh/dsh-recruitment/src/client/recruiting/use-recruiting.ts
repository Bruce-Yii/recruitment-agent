// 招聘工作区（W2）**客户端数据层**：只调宿主 HTTP 只读路由 + 后端 action seam。
//
// 与渲染分离：本文件负责"取数 / 取消 / 错误归一化 / 重新 GET"，组件只负责渲染视图模型。
// 硬约束：
//   · 只从 props 拿 sessionId/alias，**不读 localStorage**；本文件也不碰存储；
//   · 每个请求都带 `x-recruitment-request: 1` + `cache:'no-store'`，卸载时 AbortController 取消；
//   · 非 2xx 的 `{error:{code,reason_code,message}}` 原样保留（status/code/reason_code/message/rawBody），
//     界面显示服务端原文，**不把失败说成空数据**；
//   · 写动作：`available=false` 时客户端**拒绝发请求**；`available=true` 时 POST seam，
//     成功后由调用方 `reload()` 重新 GET 服务端，禁止用本地状态伪造成功。
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
  normalizeApplicationDetail,
  normalizeJobDetail,
  normalizeOverviewView,
  type ActionView,
  type ApplicationDetailView,
  type JobDetailView,
  type RecruitingOverviewView,
} from './view-model.ts'

/** 只读路由前缀（独立前缀，见 `src/http/recruiting.ts`）。 */
export const RECRUITING_API_PREFIX = '/recruitment/api/recruiting'
/** 同源标记头：宿主只放行带 `x-recruitment-request: 1` 的请求。 */
export const RECRUITING_REQUEST_HEADER = 'x-recruitment-request'
/** 允许的写动作 seam 前缀（同源相对路径，防跨源/开放跳转）。 */
const ACTION_SEAM_PREFIX = '/recruitment/'

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

/** 统一请求：网络异常转可读错误；非 2xx 转 `RecruitingRequestError`。 */
async function requestRaw(url: string, init: RequestInit, signal?: AbortSignal): Promise<RawResponse> {
  let response: Response
  try {
    response = await fetch(url, {
      cache: 'no-store',
      ...init,
      ...(signal !== undefined ? { signal } : {}),
      headers: { [RECRUITING_REQUEST_HEADER]: '1', ...init.headers },
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
 * @returns 解析后的原始 JSON（空体为 null）。
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

/** POST 一个写动作 seam 的结果。 */
export interface ActionPostResult {
  /** 服务端是否 2xx 受理（**不代表业务成功**——成功与否由重新 GET 后的服务端事实决定）。 */
  readonly accepted: boolean
  /** HTTP 状态码（未发请求 / 网络失败为 0）。 */
  readonly status: number
  /** 服务端响应体原文（截断 2000）。 */
  readonly bodyText: string
  /** 失败 / 被拒绝时的错误信息。 */
  readonly error: RecruitingErrorInfo | null
}

/**
 * POST 后端 action seam（JSON + `x-recruitment-request: 1`）。
 *
 * 安全口径：
 *   · `action.available !== true` → **不发请求**，返回 CLIENT_REFUSED；
 *   · seam 必须是同源 `/recruitment/` 相对路径 → 否则同样拒绝（防跨源写）；
 *   · 2xx 只算"服务端受理"，调用方必须随后 `reload()` 重新 GET 服务端事实。
 * @param action - 归一化后的写动作（来自 `overview.actions` / 详情 `actions`）。
 * @returns 受理状态 / 原文 / 错误。
 */
export async function postActionSeam(action: ActionView): Promise<ActionPostResult> {
  if (!action.available) {
    return {
      accepted: false,
      status: 0,
      bodyText: '',
      error: {
        status: 0,
        code: 'CLIENT_REFUSED',
        reasonCode: action.pending,
        message: `动作 ${action.key} 不可用（${action.pendingText}），客户端不发送请求`,
        rawBody: '',
      },
    }
  }
  if (!action.seam.startsWith(ACTION_SEAM_PREFIX) || action.seam.startsWith('//')) {
    return {
      accepted: false,
      status: 0,
      bodyText: '',
      error: {
        status: 0,
        code: 'CLIENT_REFUSED',
        reasonCode: 'UNSAFE_SEAM',
        message: `动作 ${action.key} 的 seam 不是同源 /recruitment/ 路径：${action.seam}`,
        rawBody: '',
      },
    }
  }
  try {
    const raw = await requestRaw(action.seam, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return { accepted: true, status: raw.status, bodyText: raw.bodyText.slice(0, 2000), error: null }
  } catch (failure: unknown) {
    if (failure instanceof RecruitingRequestError) {
      return { accepted: false, status: failure.info.status, bodyText: failure.info.rawBody, error: failure.info }
    }
    return { accepted: false, status: 0, bodyText: '', error: toRecruitingErrorInfo(failure) }
  }
}
