// 飞书 Minutes Connector 的**接线层**：把「插件配置」翻译成「可注入适配器」。
//
// 为什么单开一个文件：`adapter.ts` 刻意不碰子进程、不读配置，只有调用方显式注入
// 传输层才会真去调 CLI。此前全仓没有任何工具 import 连接器 —— 按 R2/E4，
// 「实现了但没接线」= BLOCKED。本文件就是那条线，并且只做**三件**受约束的事：
//
//   1. **传输层只能来自插件配置**：只有 `feishu.cli`（lark-cli 的**绝对路径**）才会
//      装配 `createLarkCliTransport(...)`。不给 = 不装配（默认态），回读路径一律
//      fail-closed，绝不拉起任何进程。
//   2. **绝不从环境变量找 CLI**：不读 `PATH`、不读 `process.env` 里任何 CLI 路径、
//      不替调用方猜可执行文件。`AGENTS.md §7.6`：不得把「开发者全局 CLI profile」
//      当产品连接器凭据。`env` 参数只用于适配器的**凭据存在性布尔**
//      （`FEISHU_APP_ID` 等，值不会被读出这个文件），与「CLI 从哪来」无关。
//   3. **相对路径 = 配置错误，不是 fallback**：给了 `lark-cli` 这种相对名字时，
//      直接拒绝装配并写清 issue —— 否则就会变成「PATH 上恰好装了就能跑」，
//      那正是要禁掉的那条路。
//
// LIVE 标签纪律不变：本文件不产任何标签；它只负责声明「这条 runner 是不是
// 平台通道」（`platform_channel: true`）。是否 LIVE 仍由 `labels.ts` 的
// `evaluateLiveGate()` 按**本次回读证据**算出：通道声明只是证据之一，回执
// `@sha256:` / content_sha256 与 raw_text 重算一致 / 重读哈希 / 带偏移
// fetched_at / 完整分页 / 非空正文缺一项就不是 LIVE。见 README §5/§7。
import { isAbsolute } from 'node:path'

import { createFeishuMinutesAdapter, type FeishuMinutesAdapter } from './adapter.ts'
import {
  createLarkCliTransport,
  createProcessCliRunner,
} from './transport.ts'

/** 插件配置里的 `feishu` 段（`cordis.patch.yml` 的 `config.feishu`，可选）。 */
export interface FeishuConnectorConfig {
  /**
   * lark-cli 的**绝对路径**。给了才装配传输层；缺省 = 不装配（默认态）。
   * 不得写相对路径 / 命令名（本项目禁止依赖 PATH 上的全局 CLI）。
   */
  readonly cli?: string
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
  /** 配置层问题（例如 cli 不是绝对路径）；只进 BLOCKED 的 detail，不含值。 */
  readonly issues: readonly string[]
}

/**
 * 把插件配置翻译成连接器依赖。**纯配置解析**：不做任何 I/O，不探测 CLI 是否存在
 * （找不到可执行文件由传输层的 `locate-cli` 阶段报 `CLI_UNAVAILABLE`）。
 *
 * @param config - `config.feishu` 段；缺省为空对象。
 * @param env - 仅用于适配器的凭据**存在性**判断（默认 `process.env`）；不用于取 CLI 路径。
 * @returns 解析结果；`connector === undefined` 表示默认态（不装配传输层）。
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
  // 配了但不绝对：拒绝装配。否则 Windows 上按裸命令名拉起 lark-cli 会走 PATH / 全局
  // profile，正是「开发者全局 CLI 当产品凭据」那条被禁的路。
  if (!isAbsolute(rawCli)) {
    return {
      transport_configured: false,
      issues: [
        'config.feishu.cli must be an absolute path to lark-cli '
        + '(a relative name would resolve through PATH / the developer global CLI profile, which is forbidden)',
      ],
    }
  }
  const transport = createLarkCliTransport({
    runner: createProcessCliRunner({
      command: rawCli,
      ...(config.timeout_ms === undefined ? {} : { timeout_ms: config.timeout_ms }),
    }),
    // 插件配置给了 lark-cli 的绝对路径 = 这条 runner 是**真实平台通道**。
    // 这不是数据证据：LIVE 还要过 evaluateLiveGate() 的全部证据项；
    // 但把假 CLI 配进生产配置就是运维在撒谎，本地代码无法识别。
    platform_channel: true,
    ...(config.timeout_ms === undefined ? {} : { timeout_ms: config.timeout_ms }),
    ...(config.max_attempts === undefined ? {} : { max_attempts: config.max_attempts }),
    ...(config.retry_base_ms === undefined ? {} : { retry_base_ms: config.retry_base_ms }),
  })
  // env 只影响凭据存在性布尔；适配器不会把值外传（见 adapter.ts probe()）。
  const adapter = createFeishuMinutesAdapter({ transport, env })
  return {
    connector: { adapter, transport_configured: true },
    transport_configured: true,
    issues: [],
  }
}
