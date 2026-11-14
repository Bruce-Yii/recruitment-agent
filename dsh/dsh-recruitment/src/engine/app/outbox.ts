// vendored from dsh-superagent-prototype src/app/outbox.ts；改动：
//   1. 参数属性改为显式字段声明；
//   2. 宿主依赖由 `SourceRegistry` + `Commands` 收窄为结构化窄接口（`OutboxChannels`）：本 vendor 子集不搬
//      sources/ 与 infra/commands.ts，Outbox 实际只用到 instance / channelAllowed / send 三个方法，
//      这正是文档允许的「Vendor + 轻量适配」。
/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

/** The Source-side capability the Outbox needs to hand a message over: registered instance, channel admission, and send. */
export interface OutboxChannels {
  instance(source: string): { enabled: boolean } | undefined
  channelAllowed(channel: { source: string; address: Record<string, string> }): boolean
  send(message: OutboundMessage, commands: unknown): Promise<'sent' | 'gone' | 'waiting'>
}

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: OutboxChannels
  /** Opaque to the Outbox: forwarded to the channel's send. */
  readonly commands: unknown
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  private readonly host: OutboxHost
  constructor(host: OutboxHost) {
    this.host = host
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
