// G-18：企业组织配置（角色与流程模板）客户端写入口，复用既有的 POST /recruitment/api/action/config/* 路由。
export const ORG_CONFIG_ACTION_PATHS = {
  role: '/recruitment/api/action/config/role',
  pipeline: '/recruitment/api/action/config/pipeline',
} as const

export const ORG_ROLE_SCOPE_OPTIONS: ReadonlyArray<{ readonly code: string; readonly label: string }> = [
  { code: 'JOB_READ', label: '查看岗位' },
  { code: 'JOB_WRITE', label: '创建/维护岗位' },
  { code: 'APPLICATION_READ', label: '查看候选人与申请' },
  { code: 'APPLICATION_WRITE', label: '推进候选人阶段' },
  { code: 'INTERVIEW_READ', label: '查看面试安排' },
  { code: 'INTERVIEW_WRITE', label: '安排/调整面试' },
  { code: 'SCORECARD_SUBMIT', label: '提交面试评价' },
  { code: 'DECISION_RECORD', label: '记录正式决定' },
  { code: 'CONFIG_ADMIN', label: '维护企业配置' },
]

export interface CreateOrgRoleForm {
  readonly code: string
  readonly name: string
  readonly description?: string
  readonly permissionScopes: readonly string[]
}

export interface CreateOrgPipelineForm {
  readonly code: string
  readonly name: string
  readonly description?: string
}

export function buildCreateRoleBody(input: CreateOrgRoleForm): Record<string, unknown> {
  const code = input.code.trim()
  const name = input.name.trim()
  if (code === '') throw new Error('请填写角色编码（例如 hiring_partner）')
  if (name === '') throw new Error('请填写角色名称')
  if (input.permissionScopes.length === 0) throw new Error('请至少勾选一项权限范围')
  const body: Record<string, unknown> = {
    operation: 'create',
    code,
    name,
    permission_scopes: [...input.permissionScopes],
  }
  if (input.description && input.description.trim() !== '') {
    body.description = input.description.trim()
  }
  return body
}

export function buildCreatePipelineBody(input: CreateOrgPipelineForm): Record<string, unknown> {
  const code = input.code.trim()
  const name = input.name.trim()
  if (code === '') throw new Error('请填写模板编码（例如 tech_standard）')
  if (name === '') throw new Error('请填写模板名称')
  const body: Record<string, unknown> = {
    operation: 'create',
    code,
    name,
  }
  if (input.description && input.description.trim() !== '') {
    body.description = input.description.trim()
  }
  return body
}

async function postOrgConfigAction(
  sid: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-recruitment-request': '1',
      'X-DSH-Session': sid,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* ignore non-JSON */
  }
  if (!res.ok) {
    const errObj = parsed.error as { message?: string } | undefined
    throw new Error(errObj?.message || `保存企业配置失败（HTTP ${res.status}）`)
  }
  return parsed
}

export async function createOrgRole(sid: string, input: CreateOrgRoleForm): Promise<Record<string, unknown>> {
  return postOrgConfigAction(sid, ORG_CONFIG_ACTION_PATHS.role, buildCreateRoleBody(input))
}

export async function createOrgPipeline(
  sid: string,
  input: CreateOrgPipelineForm,
): Promise<Record<string, unknown>> {
  return postOrgConfigAction(sid, ORG_CONFIG_ACTION_PATHS.pipeline, buildCreatePipelineBody(input))
}
