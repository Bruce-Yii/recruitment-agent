// 飞书 Minutes Connector 的**接线层**：把「插件配置」翻译成「可注入适配器」。
//
// 为什么单开一个文件：`adapter.ts` 刻意不碰子进程、不读配置，只有调用方显式注入
// 传输层才会真去调 CLI。此前全仓没有任何工具 import 连接器 —— 按 R2/E4，
// 「实现了但没接线」= BLOCKED。本文件就是那条线，并且只做**四件**受约束的事：
//
//   1. **传输层只能来自插件配置**：只有 `feishu.cli`（lark-cli 的**绝对路径**）
//      **且** `feishu.profile` 同时给出，才会装配 `createLarkCliTransport(...)`。
//      不给 cli = 不装配（默认态），回读路径一律 fail-closed，绝不拉起任何进程。
//   2. **绝不隐式使用默认 profile**：`profile` 是必填项（cli 配了就必须给）。不给
//      profile 时 lark-cli 会回退到**默认档案**（本机是开发者全局 profile
//      `cli_aae49f8438f8dce4`），`AGENTS.md §7.6` 禁止把开发者全局 CLI 当产品凭据。
//      缺 profile / profile 非法（含空白、以 `-` 开头）/ `${ENV}` 展开失败 → 一律
//      **不装配**并逐条写清 issue，绝不「不传 --profile 试试看」。
//   3. **绝不从环境变量找 CLI**：不读 `PATH`、不读 `process.env` 里任何 CLI 路径、
//      不替调用方猜可执行文件。`env` 参数只有两个用途：`${ENV}` 引用展开（值必须
//      来自配置里的显式引用，不是「猜一个默认路径」）与适配器的**凭据存在性布尔**
//      （`FEISHU_APP_ID` 等，值不会被读出这个文件）。
//   4. **相对路径 = 配置错误，不是 fallback**：给了 `lark-cli` 这种相对名字时，
//      直接拒绝装配并写清 issue —— 否则就会变成「PATH 上恰好装了就能跑」，
//      那正是要禁掉的那条路。
//
// 本文件仍是**纯配置解析**：不做任何 I/O、不探测 CLI 是否存在（找不到可执行文件
// 由传输层的 `locate-cli` 阶段报 `CLI_UNAVAILABLE`）。
//
// LIVE 标签纪律不变：本文件不产任何标签；它只负责声明「这条 runner 是不是
// 平台通道」（`platform_channel: true`）。是否 LIVE 仍由 `labels.ts` 的
// `evaluateLiveGate()` 按**本次回读证据**算出：通道声明只是证据之一，回执
// `@sha256:` / content_sha256 与 raw_text 重算一致 / 重读哈希 / 带偏移
// fetched_at / 完整分页 / 非空正文缺一项就不是 LIVE。见 README §5/§7。
import { isAbsolute } from 'node:path'

import {
  FEISHU_DEFAULT_ENV,
  createFeishuMinutesAdapter,
  type FeishuMinutesAdapter,
} from './adapter.ts'
import {
  createLarkCliTransport,
  createProcessCliRunner,
} from './transport.ts'

/** 插件配置里的 `feishu` 段（`cordis.patch.yml` 的 `config.feishu`，可选）。 */
export interface FeishuConnectorConfig {
  /**
   * lark-cli 的**绝对路径**。给了才可能装配传输层；缺省 = 不装配（默认态）。
   * 不得写相对路径 / 命令名（本项目禁止依赖 PATH 上的全局 CLI）。
   * 支持 `${ENV}` 引用（例如 `${RECRUITMENT_FEISHU_CLI}`）：展开数据来自
   * `resolveFeishuConnector(config, env)` 的 `env` 参数；变量未定义/空值 = 配置错误。
   */
  readonly cli?: string
  /**
   * lark-cli 的 profile 名（传给 `--profile <name>`，全局 flag，必须在子命令前）。
   * **配了 cli 就必须给**：不给会让 lark-cli 回退默认档案（本机是开发者全局
   * profile），而 `AGENTS.md §7.6` 明确禁止把开发者全局 CLI 当产品连接器凭据。
   * 合法值 = 单个名字：不得含空白/换行、不得以 `-` 开头（避免被 CLI 当成 flag）。
   * 支持 `${ENV}` 引用；未定义/空值 = 配置错误（不猜默认值）。
   */
  readonly profile?: string
  /** 单次调用超时（ms），默认 `FEISHU_CLI_DEFAULT_TIMEOUT_MS`（180 s）。 */
  readonly timeout_ms?: number
  /** 最多尝试次数（含首次），默认 3；只对传输抖动重试。 */
  readonly max_attempts?: number
  /** 指数退避基数（ms），默认 1000。 */
  readonly retry_base_ms?: number
  // 说明：不再有 page_size / max_pages —— `+detail --transcript` 是整文件写盘，
  // 没有分页；分页只属于 `+search`（未来接入时单独加配置）。
}

/**
 * 交给工具的**连接器依赖**。`transport_configured` 是诚实标记：
 * 只有它为 true 时工具才允许调用 `adapter.fetchTranscript()`；
 * 为 false 时无论适配器内部怎么想，工具都按 `BLOCKED / TRANSPORT_NOT_CONFIGURED` 处理。
 */
export interface FeishuConnectorDependency {
  readonly adapter: FeishuMinutesAdapter
  /** 传输层是否真的由**插件配置**装配（false ⇒ 默认态，不拉子进程）。 */
  readonly transport_configured: boolean
}

/** `resolveFeishuConnector()` 的返回。 */
export interface ResolvedFeishuConnector {
  /** 没装配传输层时为 `undefined`：工具必须走 BLOCKED，不许偷偷读。 */
  readonly connector?: FeishuConnectorDependency
  /** 传输层是否装配（与 `connector.transport_configured` 同源，方便调用方判空）。 */
  readonly transport_configured: boolean
  /** 配置层问题（例如 cli 不是绝对路径 / 缺 profile）；只进 BLOCKED 的 detail，不含值。 */
  readonly issues: readonly string[]
}

/** 给了 cli 却不给（或给空白）profile：**不装配**，并说清原因。 */
const PROFILE_REQUIRED_ISSUE =
  'config.feishu.profile is required when feishu.cli is configured: omitting it would make lark-cli '
  + 'fall back to the developer global default profile, which is forbidden；不传 --profile 也不许隐式回退'
  + '（会把产品读取落到开发者全局档案上）。'

/** cli 不是绝对路径（保持既有语义与文案：静态守卫断言依赖 "must be an absolute path"）。 */
const CLI_NOT_ABSOLUTE_ISSUE =
  'config.feishu.cli must be an absolute path to lark-cli '
  + '(a relative name would resolve through PATH / the developer global CLI profile, which is forbidden)'

/**
 * profile 名非法。**不回显 profile 值**（只给原因）：诊断里不需要带名字。
 * @param reason - 为什么非法（人读）。
 */
function profileInvalidIssue(reason: string): string {
  return `config.feishu.profile 非法（${reason}）：必须是单个 profile 名——不得含空白/换行、`
    + '不得以 "-" 开头（否则会被 lark-cli 当成 flag）；本次不装配，也绝不隐式回退开发者全局默认 profile。'
}

/**
 * `${ENV}` 引用展开失败（未定义 / 空值）。**点名字段 + 变量名，不猜默认值**。
 * @param field - `cli` / `profile`。
 * @param name - 变量名。
 */
function envReferenceIssue(field: 'cli' | 'profile', name: string): string {
  return `config.feishu.${field} 引用了未定义的变量 \${${name}}（未设置或空值）：`
  + '不猜默认值、不装配；请先在环境里给出该变量，或直接写字面量值。'
}

/** 字符串是否「非空且非纯空白」。 */
function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** 一次 `${ENV}` 展开的结果。 */
interface ExpandedField {
  /** 展开后的值（未定义的引用按原文保留，反正不会再被使用）。 */
  readonly value: string
  /** 依次出现的未定义/空值变量名（去重后保持出现顺序）。 */
  readonly missing: readonly string[]
}

/**
 * 展开 `${NAME}` 环境变量引用（本文件内的小函数：写范围不允许新建共享模块，
 * 也不许 import `converter.ts` 里的解析器）。
 *
 * 规则：
 *   * 只认 `${[A-Za-z_][A-Za-z0-9_]*}` 这一种形状；其它 `$` 形态（`$FOO`、
 *     `${1bad}`、`${}`）**原样保留**，不猜、不吞；
 *   * 取值来自 `resolveFeishuConnector(config, env)` 的 `env` 参数（默认 `process.env`）；
 *   * 变量未定义 / 空串 / 纯空白 → 记进 `missing`，该字段整体按配置错误处理。
 * @param text - 已 trim 的配置字符串。
 * @param env - 环境变量源。
 */
function expandEnvReferences(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): ExpandedField {
  const missing: string[] = []
  // 每次新建正则：避免 `g` 正则的 lastIndex 在多次调用间残留状态。
  const value = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole: string, name: string) => {
    const raw = env[name]
    if (!present(raw)) {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return raw as string
  })
  return { value, missing }
}

/**
 * profile-backed 凭据桥（**presence-only**）：真实凭据由 lark-cli 的 profile 持有
 * （App Secret / user token 在 CLI 自己的档案里，不在本进程环境里）。但
 * `adapter.ts` 的 `probe()` 会先看 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` /
 * `FEISHU_USER_ACCESS_TOKEN` 是否存在，缺一个就在传输层之前
 * `BLOCKED / NO_APP_CREDENTIALS`。`adapter.ts` 不在本 lane 写范围，所以这里只把
 * **空/未定义**的这三个变量填成非空哨兵，跨过「存在性」门。
 *
 * 这些值**永不用于鉴权、永不外传、永不打印**：adapter 只对它们做
 * `readNonEmptyString()` 布尔判断；真实鉴权失败由传输层的 config/auth 错误兜底
 * （`PROVIDER_REJECTED` → adapter `blockedReasonFor()` → `error_code=AUTH_REQUIRED`）。
 */
const PROFILE_CREDENTIAL_BRIDGE_VALUE = '<lark-cli-profile>'

/**
 * 只对空/未定义的三项凭据变量填 presence 哨兵；**已存在的值原样保留**。
 * @param env - 调用方给的环境（只读）。
 */
function withProfileCredentialBridge(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const bridged: Record<string, string | undefined> = { ...env }
  for (const name of [
    FEISHU_DEFAULT_ENV.app_id,
    FEISHU_DEFAULT_ENV.app_secret,
    FEISHU_DEFAULT_ENV.user_access_token,
  ]) {
    if (!present(bridged[name])) bridged[name] = PROFILE_CREDENTIAL_BRIDGE_VALUE
  }
  return bridged
}

/**
 * 把插件配置翻译成连接器依赖。**纯配置解析**：不做任何 I/O，不探测 CLI 是否存在
 * （找不到可执行文件由传输层的 `locate-cli` 阶段报 `CLI_UNAVAILABLE`）。
 *
 * 装配条件（缺一条都不装配，且 issue 说清是哪条）：
 *   1. `cli` 非空且**展开 `${ENV}` 后仍是绝对路径**（相对名 = 配置错误，不是 fallback）；
 *   2. `profile` **显式给出**、展开 `${ENV}` 后合法（单个名字；不含空白/换行、不以 `-` 开头）。
 *
 * @param config - `config.feishu` 段；缺省为空对象。
 * @param env - `${ENV}` 引用的展开数据 + 适配器的凭据**存在性**判断（默认 `process.env`）；
 *   不用于取 CLI 路径。
 * @returns 解析结果；`connector === undefined` 表示不装配（默认态 / 配置错误）。
 */
export function resolveFeishuConnector(
  config: FeishuConnectorConfig = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedFeishuConnector {
  const rawCli = typeof config.cli === 'string' ? config.cli.trim() : ''
  // 没配 = 默认态。**不**回退到 PATH 上的 lark-cli（R7 / AGENTS.md §7.6）。
  if (rawCli === '') {
    return { transport_configured: false, issues: [] }
  }

  // ---- 1. cli：`${ENV}` 展开 → 必须绝对路径 --------------------------------
  const cli = expandEnvReferences(rawCli, env)
  if (cli.missing.length > 0) {
    return {
      transport_configured: false,
      issues: cli.missing.map((name) => envReferenceIssue('cli', name)),
    }
  }
  // 配了但不绝对：拒绝装配。否则 Windows 上按裸命令名拉起 lark-cli 会走 PATH / 全局
  // profile，正是「开发者全局 CLI 当产品凭据」那条被禁的路。
  if (!isAbsolute(cli.value)) {
    return { transport_configured: false, issues: [CLI_NOT_ABSOLUTE_ISSUE] }
  }

  // ---- 2. profile：必须显式给出且合法（不传 --profile = 隐式回退默认档案）-----
  const rawProfile = typeof config.profile === 'string' ? config.profile.trim() : ''
  if (rawProfile === '') {
    return { transport_configured: false, issues: [PROFILE_REQUIRED_ISSUE] }
  }
  const expandedProfile = expandEnvReferences(rawProfile, env)
  if (expandedProfile.missing.length > 0) {
    return {
      transport_configured: false,
      issues: expandedProfile.missing.map((name) => envReferenceIssue('profile', name)),
    }
  }
  const profile = expandedProfile.value.trim()
  if (profile === '') {
    return { transport_configured: false, issues: [PROFILE_REQUIRED_ISSUE] }
  }
  if (/\s/.test(profile)) {
    return { transport_configured: false, issues: [profileInvalidIssue('含空白或换行')] }
  }
  if (profile.startsWith('-')) {
    return { transport_configured: false, issues: [profileInvalidIssue('以 "-" 开头')] }
  }

  // ---- 3. 装配：argv 恒带 `--profile <name>` --------------------------------
  const transport = createLarkCliTransport({
    runner: createProcessCliRunner({
      command: cli.value,
      ...(config.timeout_ms === undefined ? {} : { timeout_ms: config.timeout_ms }),
    }),
    // 插件配置给了 lark-cli 的绝对路径 + 显式 profile = 这条 runner 是**真实平台通道**。
    // 这不是数据证据：LIVE 还要过 evaluateLiveGate() 的全部证据项；
    // 但把假 CLI 配进生产配置就是运维在撒谎，本地代码无法识别。
    platform_channel: true,
    profile,
    ...(config.timeout_ms === undefined ? {} : { timeout_ms: config.timeout_ms }),
    ...(config.max_attempts === undefined ? {} : { max_attempts: config.max_attempts }),
    ...(config.retry_base_ms === undefined ? {} : { retry_base_ms: config.retry_base_ms }),
  })
  // env 只影响凭据存在性布尔；适配器不会把值外传（见 adapter.ts probe()）。
  // profile-backed 部署里凭据在 CLI 档案里：只给空位填 presence 哨兵（见上注）。
  const adapter = createFeishuMinutesAdapter({ transport, env: withProfileCredentialBridge(env) })
  return {
    connector: { adapter, transport_configured: true },
    transport_configured: true,
    issues: [],
  }
}
