// 客户端数据层：只调宿主 HTTP 路由，绝不直连数据库（浏览器不持有 DB 凭据）。
//
// 与渲染分离：`use-overview.ts` 负责"拿到数据并归一化成安全形状"，
// `Workbench.tsx` 只负责"把拿到的数据渲染出来"。这样之后替换视觉版 HTML 时，
// 只需要换渲染层，取数/校验不动。
//
// 归一化不是洁癖：HTTP 200 + 半个字段、或后端将来改了形状，界面会显示
// `undefined` / `NaN` / `[object Object]`。这里把所有字段收紧成
// 字符串或非负整数，缺失一律降到空串 / 0 / 空数组。

import { useCallback, useEffect, useState } from 'react'

/** 一条待人工决定的申请（与宿主 `PendingDecisionRow` 对齐）。 */
export interface PendingDecision {
  readonly application_id: string
  readonly stage_code: string
  readonly reason: string
}

/** 计数（全部为非负整数）。 */
export interface OverviewCounts {
  readonly pending_total: number
  readonly by_stage: Readonly<Record<string, number>>
  readonly active_applications: number
}

/** 工作台投影响应（与宿主 `OverviewResponse` 对齐）。 */
export interface OverviewResponse {
  readonly configured: boolean
  readonly pending: readonly PendingDecision[]
  readonly counts: OverviewCounts
  readonly issues?: readonly string[]
}

/** `useOverview` 的返回：数据、错误、加载中、重新读取。 */
export interface OverviewState {
  readonly data: OverviewResponse | undefined
  readonly error: string | undefined
  readonly loading: boolean
  readonly reload: () => void
}

/** 宿主只读路由（同源相对路径）。 */
const ENDPOINT = '/recruitment/api/overview'
/** 同源标记头（宿主侧 `x-recruitment-request: 1` 才放行）。 */
const REQUEST_HEADER = 'x-recruitment-request'

/** 取一个非空字符串；否则用兜底。 */
function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** 取一个非负有限数字；否则 0（杜绝 NaN / Infinity / 字符串数字）。 */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

/** 把任意响应体归一化成 `OverviewResponse`：字段缺失不抛错，只降级。 */
export function normalizeOverview(value: unknown): OverviewResponse {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>

  const pending: PendingDecision[] = []
  if (Array.isArray(raw.pending)) {
    for (const item of raw.pending) {
      if (item === null || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const application_id = asText(row.application_id)
      // 没有 application_id 的行无法渲染也无法当 key，直接丢弃（不是伪造一个 id）。
      if (application_id === '') continue
      pending.push({
        application_id,
        stage_code: asText(row.stage_code, '未知阶段'),
        reason: asText(row.reason, '未提供原因'),
      })
    }
  }

  const countsRaw = (raw.counts !== null && typeof raw.counts === 'object' ? raw.counts : {}) as Record<string, unknown>
  const byStageRaw = (countsRaw.by_stage !== null && typeof countsRaw.by_stage === 'object' ? countsRaw.by_stage : {}) as Record<string, unknown>
  const by_stage: Record<string, number> = {}
  for (const [stageCode, count] of Object.entries(byStageRaw)) {
    const key = asText(stageCode)
    if (key !== '') by_stage[key] = asCount(count)
  }

  const issues = Array.isArray(raw.issues)
    ? raw.issues.filter((issue): issue is string => typeof issue === 'string')
    : []

  return {
    configured: raw.configured === true,
    pending,
    counts: {
      pending_total: countsRaw.pending_total === undefined ? pending.length : asCount(countsRaw.pending_total),
      by_stage,
      active_applications: asCount(countsRaw.active_applications),
    },
    ...(issues.length > 0 ? { issues } : {}),
  }
}

/**
 * 读取一次工作台投影；网络错误 / HTTP 错误 / 坏 JSON 都变成可读的错误文本。
 * @param signal - 组件卸载时用于放弃请求。
 * @returns 归一化后的响应。
 * @throws {Error} 当宿主返回非 2xx 或响应体不是 JSON 时。
 */
async function fetchOverview(signal: AbortSignal): Promise<OverviewResponse> {
  const response = await fetch(ENDPOINT, {
    method: 'GET',
    headers: { [REQUEST_HEADER]: '1' },
    cache: 'no-store',
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    const detail = text.trim() === '' ? '' : `：${text.slice(0, 200)}`
    throw new Error(`宿主返回 HTTP ${response.status}${detail}`)
  }
  let parsed: unknown
  try {
    parsed = text.trim() === '' ? undefined : (JSON.parse(text) as unknown)
  } catch {
    throw new Error('宿主返回的不是 JSON')
  }
  return normalizeOverview(parsed)
}

/**
 * 面板取数 hook：挂载时读一次，`reload()` 重新读；卸载时放弃在途请求。
 * 不做轮询——第一版的面板要证明的是"注册链路通了"，实时性不是这一版的问题。
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
