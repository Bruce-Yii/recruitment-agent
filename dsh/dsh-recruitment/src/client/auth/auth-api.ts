// 独立登录页 / 工作台的认证 API 客户端（Issue #61）。
// 路径字面量留在 client 层，便于入口可达性机检（entry-reachability）证明界面可达。

export async function postAuthLogin(username: string, password: string, role?: string): Promise<{
  ok: boolean
  status: number
  body: Record<string, unknown>
}> {
  const res = await fetch('/recruitment/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-recruitment-request': '1', Accept: 'application/json' },
    body: JSON.stringify({ username, password, ...(role ? { role } : {}) }),
  })
  let body: Record<string, unknown> = {}
  try { body = await res.json() as Record<string, unknown> } catch { /* 空响应体 */ }
  return { ok: res.ok, status: res.status, body }
}

export async function postAuthLogout(): Promise<void> {
  await fetch('/recruitment/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-recruitment-request': '1', Accept: 'application/json' },
  })
}
