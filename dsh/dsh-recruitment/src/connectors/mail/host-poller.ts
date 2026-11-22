// 宿主启动接线用的 IMAP 轮询 helper（Issue #25 / G-02 / PR #29 补尾巴）。
//
// 与 `poll.ts` 的分工：
//   * `poll.ts` 是**纯轮询器**：timer / 互斥 / 水位推进，完全不认识 IMAP/PG；
//   * 本文件把生产依赖（listOpenJobs / makeJobResolver / fetchAndIngest / IMAP transport /
//     进程内水位）装配进 `createImapPoller`，并暴露 start/stop 给 `src/index.ts` 的
//     cordis effect 生命周期。
//
// 默认关闭：`env[RECRUITMENT_IMAP_POLL_INTERVAL_MS]` 非正整数 ⇒ `resolvePollIntervalMs`
// 返回 0 ⇒ `createHostMailPoller` 返回 **null**（不建 timer、不建连接池、不启动任何东西）。
// 这是宿主启动路径的唯一开关，不读 config.runtime.enabled，也不新增配置段/迁移。
//
// 水位：**进程内内存**（闭包变量，初值 = mail.since_uid）。重启后归零，但 orchestrator
// 的 `next_since_uid` + event_inbox 的 provider_event_id 幂等索引兜底去重；不新增表/迁移。
//
// 可注入：`timer`（假时钟）、`executeOnce`（假整轮执行）让生命周期单测不碰真实 IMAP/PG。

import {
  closePool,
  createPool,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../../db/pool.ts'
import type { ToolActorDeps } from '../../demo-actor/tool-actor.ts'
import type { ResolvedConverterConfig } from '../../tools/converter.ts'
import type { ResolvedMailConfig } from '../../tools/email-fetch.ts'
import type { MailConfig } from './contract.ts'
import { listOpenJobs } from './job-lookup.ts'
import { fetchAndIngest, makeJobResolver } from './orchestrator.ts'
import {
  createImapPoller,
  resolvePollIntervalMs,
  type PollTickResult,
  type PollTimer,
} from './poll.ts'
import { createImapTransport } from './transport.ts'

/** 装配宿主轮询器所需的最小依赖（全部来自 apply 已解析好的配置）。 */
export interface HostMailPollerInput {
  /** 环境变量表（含显式开关 RECRUITMENT_IMAP_POLL_INTERVAL_MS）。 */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly database: ResolvedDatabaseConfig
  readonly mail: ResolvedMailConfig
  readonly converter: ResolvedConverterConfig
  /** 写身份（与写工具同源的 Demo Actor singleton）。 */
  readonly identity?: ToolActorDeps
  /** 仅测试用：注入假 timer（不排真实定时器）。 */
  readonly timer?: PollTimer
  /**
   * 仅测试用：替换整轮执行（跳过 listOpenJobs / IMAP / PG）。
   * 生产不传：走 `listOpenJobs → makeJobResolver → fetchAndIngest`。
   */
  readonly executeOnce?: (sinceUid: number) => Promise<PollTickResult>
  /** 观测回调（只含事件类型/原因码，不含正文/PII）。 */
  readonly onEvent?: (event: { type: string; reason?: string; error?: string }) => void
}

/** 暴露给宿主的生命周期句柄。 */
export interface HostMailPollerHandle {
  readonly intervalMs: number
  readonly start: () => void
  /** 停 timer 并等待在途 tick；幂等；关闭本 helper 懒建的在招岗位查询连接池。 */
  readonly stop: () => Promise<void>
  readonly isRunning: () => boolean
}

/**
 * 造宿主轮询器。未显式配置正整数间隔 ⇒ 返回 null（默认关闭，零副作用）。
 * 配置齐全时也不立即 start：由调用方在 effect 内 start，cleanup 内 stop。
 */
export function createHostMailPoller(input: HostMailPollerInput): HostMailPollerHandle | null {
  const intervalMs = resolvePollIntervalMs(input.env)
  if (intervalMs <= 0) return null

  // 进程内水位：不新增表/迁移；重启后从 mail.since_uid 重新开始，幂等由 event_inbox 兜底。
  let watermark = Number.isFinite(input.mail.since_uid) && input.mail.since_uid > 0
    ? Math.floor(input.mail.since_uid)
    : 0
  // 在招岗位查询连接池：懒建（第一轮真的要跑时才建）；stop 时关闭。
  let jobsPool: DatabasePool | null = null
  let jobsPoolClosed = false

  const runOnce = async (sinceUid: number): Promise<PollTickResult> => {
    if (input.executeOnce !== undefined) return input.executeOnce(sinceUid)

    if (jobsPool === null) jobsPool = createPool(input.database)
    // 每轮重新查在招岗位（岗位开关是运行期事实，不能缓存到进程启动那一刻）。
    const jobs = await listOpenJobs(jobsPool, input.database)
    const resolver = makeJobResolver(jobs)
    const result = await fetchAndIngest(
      { job_id: '', since_uid: sinceUid, jobResolver: resolver },
      {
        transport: createImapTransport(input.mail as MailConfig),
        cfg: {
          database: input.database,
          converter: input.converter,
          mail: input.mail as MailConfig,
        },
        ...(input.identity === undefined ? {} : { identity: input.identity }),
      },
    )
    return {
      next_since_uid: result.next_since_uid,
      progressed: result.connection === 'CONNECTED',
    }
  }

  const poller = createImapPoller({
    intervalMs,
    runOnce,
    loadWatermark: () => watermark,
    saveWatermark: (uid) => { watermark = uid },
    ...(input.timer === undefined ? {} : { timer: input.timer }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  })
  // intervalMs > 0 保证非 null；防御式判空让类型收窄，也保护未来对 createImapPoller 的改动。
  if (poller === null) return null

  return {
    intervalMs,
    start: () => { poller.start() },
    stop: async () => {
      await poller.stop()
      if (jobsPool !== null && !jobsPoolClosed) {
        jobsPoolClosed = true
        await closePool(jobsPool)
      }
    },
    isRunning: () => poller.isRunning(),
  }
}
