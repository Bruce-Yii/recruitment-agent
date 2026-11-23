// Issue #60：外部同步的客户端契约（与 src/http/export.ts 的 EXPORT_PATHS 逐字一致）。
// 放在 src/client 让 entry-reachability 能机检到真实入口；SettingsView 直接复用。
export const EXTERNAL_SYNC_PATHS = {
  applicationsCsv: '/recruitment/api/export/applications.csv',
  webhookTest: '/recruitment/api/action/webhook/test',
} as const

/** 同源真实 CSV 下载（带 DSH session；HTTP 失败如实抛错，绝不前端伪造）。 */
export async function downloadApplicationsCsv(sid: string, jobId?: string): Promise<{ filename: string }> {
  const params = new URLSearchParams()
  if (jobId !== undefined && jobId !== '') params.set('job_id', jobId)
  const suffix = params.toString() === '' ? '' : `?${params.toString()}`
  const res = await fetch(`${EXTERNAL_SYNC_PATHS.applicationsCsv}${suffix}`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'x-recruitment-request': '1', 'X-DSH-Session': sid },
  })
  if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`)
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  try {
    const disposition = res.headers.get('content-disposition') || ''
    const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || 'recruitment-applications.csv'
    const link = document.createElement('a')
    link.href = href
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    return { filename }
  } finally {
    URL.revokeObjectURL(href)
  }
}

/** 测试推送：返回真实 HTTP 状态；调用方按 ok/status 展示，不伪造成功。 */
export async function testWebhook(sid: string): Promise<{ ok: boolean; status: number; message: string }> {
  const res = await fetch(EXTERNAL_SYNC_PATHS.webhookTest, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-recruitment-request': '1',
      'X-DSH-Session': sid,
    },
    body: JSON.stringify({}),
  })
  const text = await res.text()
  let message = `测试推送${res.ok ? '成功' : '失败'}（HTTP ${res.status}）`
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; detail?: { error?: string } } }
    if (parsed.error?.message) message = parsed.error.message
    if (parsed.error?.detail?.error) message += `：${parsed.error.detail.error}`
  } catch { /* 非 JSON 响应用状态兜底 */ }
  return { ok: res.ok, status: res.status, message }
}
