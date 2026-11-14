// 插件配置里的 `runtime` 段：默认不启用，缺配置逐条列 issues（与 db/pool.ts 同风格）。
//
// 为什么默认关：产品 profile 一启动就多两个 POST 口子（即使有 loopback/同源校验）
// 不是好默认；事件运行时是要显式打开的运行时能力。
import { join } from 'node:path'
import type { NotificationTarget } from './types.ts'
import type { DshWorkerConfig } from './worker.ts'

/** `cordis.patch.yml` 里的 `runtime` 段。 */
export interface RuntimeConfig {
  /** 是否注册运行时 HTTP 路由；默认 false。 */
  readonly enabled?: boolean
  /** Worker 的 DSH profile 名（必须包含可用的模型路由）。 */
  readonly worker_profile?: string
  /** `@deepseek-ai/dsh` 的 `lib/bin.js` 绝对路径；缺省读 `$DSH_INSTALL_DIR`。 */
  readonly dsh_bin?: string
  /** node 可执行文件；缺省 `process.execPath`。 */
  readonly node_bin?: string
  /** 子进程的 `DSH_HOME`；缺省继承。 */
  readonly dsh_home?: string
  /** Worker 权限预设；默认 `workspace-write`。 */
  readonly permission_mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 单次 Worker 执行超时（毫秒），默认 180000。 */
  readonly timeout_ms?: number
  /** 写进 `agent_session.runtime_version` 的版本标签（配置给出，不猜）。 */
  readonly runtime_version?: string
  /** 写进 `agent_session.model_route` 的模型路由标签（配置给出，不猜）。 */
  readonly model_route?: string
  /** Attempt 租约（毫秒），默认 900000；必须大于 timeout_ms。 */
  readonly lease_ms?: number
  /** 自动重试上限（Attempt 序号），默认 3。 */
  readonly max_attempts?: number
  /** 新 Attempt 是否续跑上次 DSH Session；默认 false（Session 可替换）。 */
  readonly resume_sessions?: boolean
  /** Worker 工作目录根；缺省 `<cwd>/work/runtime`。 */
  readonly workspace_root?: string
  /** 单轮重放待路由事件上限，默认 20。 */
  readonly pending_batch_size?: number
  /** 单条事件最多重试路由几次，默认 5。 */
  readonly max_route_attempts?: number
  /** 出站通知目标（可选）；配置后 Task 进入 WAITING_* / FAILED 时登记消息，默认不发。 */
  readonly notification?: {
    readonly source?: string
    readonly thread?: string
    readonly address?: Readonly<Record<string, string>>
    readonly kind?: 'notice' | 'reply' | 'acknowledgement'
  }
}

/** 已补默认值并校验通过的运行时配置。 */
export interface ResolvedRuntimeConfig {
  readonly enabled: true
  readonly worker: DshWorkerConfig
  readonly leaseMs: number
  readonly maxAttempts: number
  readonly resumeSessions: boolean
  readonly workspaceRoot: string | undefined
  readonly pendingBatchSize: number
  readonly maxRouteAttempts: number
  readonly notification: NotificationTarget | undefined
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_LEASE_MS = 900_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_PENDING_BATCH = 20
const DEFAULT_MAX_ROUTE_ATTEMPTS = 5

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 解析 `runtime` 段。
 * @param config - `cordis.patch.yml` 的 `runtime` 段。
 * @param env - 环境变量表（测试可注入；只读 `DSH_INSTALL_DIR` 等路径变量）。
 * @returns `resolved=null` 时 `issues` 非空、不注册任何路由（fail closed）。
 */
export function resolveRuntimeConfig(
  config: RuntimeConfig,
  env: Readonly<Record<string, string | undefined>>,
): { resolved: ResolvedRuntimeConfig | null; issues: readonly string[] } {
  if (config.enabled !== true) {
    return { resolved: null, issues: ['runtime.enabled is false (runtime routes are not registered)'] }
  }
  const issues: string[] = []
  const profile = nonEmpty(config.worker_profile)
  if (profile === '') issues.push('config.runtime.worker_profile is required (a DSH profile that has a usable model route)')
  const runtimeVersion = nonEmpty(config.runtime_version)
  if (runtimeVersion === '') issues.push('config.runtime.runtime_version is required (written to agent_session.runtime_version)')
  const modelRoute = nonEmpty(config.model_route)
  if (modelRoute === '') issues.push('config.runtime.model_route is required (written to agent_session.model_route)')

  const timeoutMs = positiveInt(config.timeout_ms, DEFAULT_TIMEOUT_MS)
  const leaseMs = positiveInt(config.lease_ms, DEFAULT_LEASE_MS)
  if (leaseMs <= timeoutMs) {
    issues.push(`config.runtime.lease_ms (${leaseMs}) must be greater than timeout_ms (${timeoutMs}), otherwise an attempt can be reclaimed while its worker is still running`)
  }
  const dshBin = nonEmpty(config.dsh_bin)
  const envInstall = nonEmpty(env.DSH_INSTALL_DIR)
  const fallbackBin = envInstall === '' ? '' : join(envInstall, 'lib', 'bin.js')
  if (dshBin === '' && fallbackBin === '') {
    issues.push('config.runtime.dsh_bin is required, or set DSH_INSTALL_DIR in the host environment')
  }

  // 出站通知可选；一旦配置就必须完整，缺字段逐个列 issue（不静默发到空地址）。
  let notification: NotificationTarget | undefined
  if (config.notification !== undefined) {
    const source = nonEmpty(config.notification.source)
    const thread = nonEmpty(config.notification.thread) === '' ? 'runtime' : nonEmpty(config.notification.thread)
    const address = config.notification.address
    if (source === '') issues.push('config.runtime.notification.source is required when notification is configured')
    if (address === undefined || address === null || typeof address !== 'object' || Array.isArray(address)) {
      issues.push('config.runtime.notification.address must be an object')
    } else {
      const pairs = Object.entries(address)
      if (pairs.length === 0) issues.push('config.runtime.notification.address must not be empty')
      for (const [name, value] of pairs) {
        if (nonEmpty(value) === '') issues.push(`config.runtime.notification.address.${name} must be a non-empty string`)
      }
    }
    const kind = config.notification.kind ?? 'notice'
    if (kind !== 'notice' && kind !== 'reply' && kind !== 'acknowledgement') {
      issues.push('config.runtime.notification.kind must be notice | reply | acknowledgement')
    }
    if (source !== '' && address !== undefined && typeof address === 'object' && !Array.isArray(address) && Object.keys(address).length > 0) {
      notification = { source, thread, address: { ...address }, kind }
    }
  }
  if (issues.length > 0) return { resolved: null, issues }

  return {
    resolved: {
      enabled: true,
      worker: {
        profile,
        nodeBin: nonEmpty(config.node_bin) === '' ? undefined : nonEmpty(config.node_bin),
        dshBin: dshBin === '' ? fallbackBin : dshBin,
        dshHome: nonEmpty(config.dsh_home) === '' ? undefined : nonEmpty(config.dsh_home),
        permissionMode: config.permission_mode ?? 'workspace-write',
        timeoutMs,
        runtimeVersion,
        modelRoute,
      },
      leaseMs,
      maxAttempts: positiveInt(config.max_attempts, DEFAULT_MAX_ATTEMPTS),
      resumeSessions: config.resume_sessions === true,
      workspaceRoot: nonEmpty(config.workspace_root) === '' ? undefined : nonEmpty(config.workspace_root),
      pendingBatchSize: positiveInt(config.pending_batch_size, DEFAULT_PENDING_BATCH),
      maxRouteAttempts: positiveInt(config.max_route_attempts, DEFAULT_MAX_ROUTE_ATTEMPTS),
      notification,
    },
    issues: [],
  }
}

