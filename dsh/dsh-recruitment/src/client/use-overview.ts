// 客户端数据层：只调宿主 HTTP 路由，绝不直连数据库（浏览器不持有 DB 凭据）。
//
// 与渲染分离：`use-overview.ts` 负责"拿到数据并归一化成安全形状"，
// `Workbench.tsx` 只负责"把拿到的数据渲染出来"。归一化纯函数在
// `normalize.ts`（无 react 依赖，可被 `node --test` 直接覆盖）。
//
// 本版新增（D-89 / G6）：
//   - overview 契约升级为 actor 视角（六个只读列表 + unassigned 共享区）；
//   - `fetchFormSpec(interviewId)`：读动态面评表单 spec；
//   - `submitScorecardForm(payload)`：按 spec 的 dimensions 提交面评。
// 所有请求都带 `x-recruitment-request: 1`、`cache:'no-store'`，POST 带 JSON 头。
// HTTP 非 2xx 的 `{error:{code,reason_code,message}}` 一律转成保留契约字段的可读错误。

import { useCallback, useEffect, useState } from 'react'
import {
  normalizeFormSpec,
  normalizeOverview,
  normalizeSubmitResult,
  parseHttpError,
  submitResultError,
  type OverviewResponse,
  type ScorecardFormSpec,
  type ScorecardSubmitResult,
} from './normalize.ts'

export {
  normalizeFormSpec,
  normalizeOverview,
  normalizeSubmitResult,
  parseHttpError,
  submitResultError,
  RecruitmentHttpError,
  type OverviewActor,
  type OverviewCounts,
  type OverviewListItem,
  type OverviewResponse,
  type OverviewUnassigned,
  type ScorecardFormSpec,
  type ScorecardSubmitResult,
  type FormDimensionControl,
} from './normalize.ts'

/** 宿主只读路由（同源相对路径）。 */
const OVERVIEW_ENDPOINT = '/recruitment/api/overview'
/** D-89 动态面评表单路由（GET spec / POST 提交）。 */
const SCORECARD_ENDPOINT = '/recruitment/api/scorecard-form'
/** 同源标记头（宿主侧 `x-recruitment-request: 1` 才放行）。 */
const REQUEST_HEADER = 'x-recruitment-request'

/** 一个维度提交时的取值（键必须来自服务端 spec）。 */
export interface ScorecardDimensionValue {
  readonly assessment: string
  readonly score?: number
  readonly note?: string
}

/** `POST /recruitment/api/scorecard-form` 的请求体（与 D-89 契约对齐）。 */
export interface ScorecardSubmitPayload {
  readonly interview_id: string
  /** 动态键：只由 spec.dimensions 构造，客户端不自由生成。 */
  readonly dimensions: Readonly<Record<string, ScorecardDimensionValue>>
  readonly transcript_basis: string
  readonly overall: string
  readonly revision?: number
}

/** `useOverview` 的返回：数据、错误、加载中、重新读取。 */
export interface OverviewState {
  readonly data: OverviewResponse | undefined
  readonly error: string | undefined
  readonly loading: boolean
  readonly reload: () => void
}

/**
 * 统一请求封装：网络错误 / 非 2xx / 坏 JSON 都变成可读错误。
 * @param url - 同源相对路径。
 * @param init - fetch 参数（方法/头/体）。
 * @returns 解析后的 JSON（空体为 undefined）。
 * @throws {RecruitmentHttpError} 非 2xx 时（保留 code / reason_code / status）。
 */
async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...init, headers: { [REQUEST_HEADER]: '1', ...init.headers } })
  } catch (error: unknown) {
    throw new Error(`网络请求失败：${error instanceof Error ? error.message : String(error)}`)
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
    throw new Error('宿主返回的不是 JSON')
  }
}

/** 读取一次工作台投影（GET `/recruitment/api/overview`）。 */
async function fetchOverview(signal?: AbortSignal): Promise<OverviewResponse> {
  const value = await requestJson(OVERVIEW_ENDPOINT, { method: 'GET', signal })
  return normalizeOverview(value)
}

/**
 * 读取 D-89 动态面评表单 spec（GET `/recruitment/api/scorecard-form`）。
 * @param interviewId - 面试 id（UUID 文本；必须来自服务端 overview 列表）。
 * @param rubricVersionId - 可选 rubric 版本 id（服务端用它锁定维度集合）。
 * @returns 归一化后的表单 spec（dimensions 顺序与键都来自服务端）。
 */
export async function fetchFormSpec(interviewId: string, rubricVersionId?: string): Promise<ScorecardFormSpec> {
  const query = new URLSearchParams({ interview_id: interviewId })
  if (rubricVersionId !== undefined && rubricVersionId !== '') query.set('rubric_version_id', rubricVersionId)
  const value = await requestJson(`${SCORECARD_ENDPOINT}?${query.toString()}`, { method: 'GET' })
  return normalizeFormSpec(value)
}

/**
 * 提交面评（POST `/recruitment/api/scorecard-form`）。
 *
 * 200 但工具层 `status !== 'OK'` 也按失败抛错（绝不把失败显示成假成功）。
 * @param payload - 由 spec.dimensions 构造的提交体。
 * @returns 归一化后的成功回显（scorecard id / revision_no / status / coverage）。
 * @throws {RecruitmentHttpError} 400/403/404/409 或工具层失败。
 */
export async function submitScorecardForm(payload: ScorecardSubmitPayload): Promise<ScorecardSubmitResult> {
  const value = await requestJson(SCORECARD_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const failure = submitResultError(value)
  if (failure !== null) throw failure
  return normalizeSubmitResult(value)
}

/**
 * 面板取数 hook：挂载时读一次，`reload()` 重新从服务端重取；卸载时放弃在途请求。
 * 不做轮询 / 实时推送——刷新必须是"重新 GET 服务端"，不是前端本地重算。
 * @returns 数据、错误、加载中、重新读取。
 */
export function useOverview(): OverviewState {
  const [data, setData] = useState<OverviewResponse | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)

  const reload = useCallback(() => {
    setGeneration((value) => value + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    fetchOverview(controller.signal)
      .then((value) => {
        if (!active) return
        setData(value)
        setError(undefined)
      })
      .catch((failure: unknown) => {
        if (!active || controller.signal.aborted) return
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [generation])

  return { data, error, loading, reload }
}
