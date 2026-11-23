// 工作空间设置的 DB 层（docs/34 §二.2-5；docs/17 D-112 配置产品化）。
//
// 一句话：**复用既有 `recruitment.business_config`，不建表、不加迁移、不新增工具**。
// 把两个可写设置键（agent_silent_delegation / sla_thresholds）当作 ORGANIZATION
// scope 的多版本 append-only 配置行读写；版本约定照
// `src/connectors/mail/durable-effect.ts::insertEmailAuthorization`（读 max(version_no)
// + effective_to → 新行 version_no=max+1、effective_from=旧 effective_to+1ms，
// 无旧版则 now()；**绝不 UPDATE 旧行**）。
//
// ── 三条纪律 ─────────────────────────────────────────────────────────
//  1. **白名单投影**：所有 select 只挑业务列（config_key/version_no/payload/
//     effective_from），**刻意不选 id / payload_hash / created_by_actor_id**
//     （照 `src/http/recruiting.ts:1608` BUSINESS_CONFIG_SQL 的纪律）。出参里也
//     只有 config_key/version_no/value/effective_from，不吐任何内部 id。
//  2. **payload 即审计**：新行的 payload 形状固定为
//       { value: <校验后的值>, confirmation_text_sha256: <服务端算的 sha256>,
//         changed_from: <旧 value 或 null>, changed_to: <新 value>,
//         updated_by_actor_id: <actorId> }
//     "变更前后值 + 更新人 + 确认哈希"全写进 payload（**无新列**），满足
//     "append-only 版本行 + 记录 updated_by_actor_id 与变更前后值"。
//     payload_hash = digestOf(payload)（src/tools/contract.ts:44，sha256(canonicalJson)）。
//  3. **事务由调用方包裹**：本文件用传入的 `DatabaseClient`，不开事务、不建连接池。
//     写路径必须在 `withActor(pool, actorId, ...)` 事务内调用（created_by_actor_id
//     外键 + actor GUC）；读路径在 `withReadOnly` 事务内调用。
import { digestOf } from '../tools/contract.ts'
import type { DatabaseClient } from './pool.ts'

/** ORGANIZATION scope（scope_id 恒 null，与 0001 的 ck_business_config_scope_id 一致）。 */
const ORGANIZATION_SCOPE = 'ORGANIZATION'

/** 当前生效行的一行投影（只有业务列）。 */
interface SettingRow {
  readonly config_key: string
  readonly version_no: number
  readonly payload: unknown
  readonly effective_from: string | Date
}

/** 当前版本的最大行（用于 append 的版本号与生效窗起点）。 */
interface MaxVersionRow {
  readonly version_no: number
  readonly effective_to: string | Date | null
}

/** `readSetting` / `readAllSettings` 的出参（**无 id / payload_hash / created_by_actor_id**）。 */
export interface SettingView {
  readonly config_key: string
  readonly version_no: number
  readonly value: unknown
  /** ISO-8601 文本（`Date` 已在行→视图这一步归一，不把 Date 透传出去）。 */
  readonly effective_from: string
}

/** `appendSettingVersion` 的入参。 */
export interface AppendSettingVersionInput {
  readonly tenantId: string
  readonly configKey: string
  /** 已由 `validateWorkspaceSettingValue` 校验过的值。 */
  readonly value: unknown
  /** 写这份数据的 actor id（来自服务端绑定，不是 body）。 */
  readonly actorId: string
  /** 服务端算的 sha256(confirmation_text)，绝不传原话。 */
  readonly confirmationTextSha256: string
}

/** `appendSettingVersion` 的出参。 */
export interface AppendSettingVersionResult {
  readonly config_key: string
  readonly version_no: number
  /** 旧值（首个版本为 null）。 */
  readonly changed_from: unknown
  readonly effective_from: string
}

/** select 白名单（刻意不含 id / payload_hash / created_by_actor_id）。 */
const SETTING_COLUMNS = `config_key, version_no, payload, effective_from`

/** 时间列 → ISO-8601 文本（行是唯一序列化点；测试替身可能给字符串）。 */
function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/**
 * 从 payload 里解出 `value` 字段。库里的历史/外部行可能形状不符；解不出就当 null
 * （不猜、不造值），由 HTTP 层的"缺行/缺值给诚实缺省"兜底。
 * @param payload - payload 列（pg 对 jsonb 默认解析成对象）。
 */
function valueFromPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  return Object.hasOwn(record, 'value') ? record.value : null
}

/**
 * 行 → 视图（白名单投影）。
 * @param row - 库里的当前生效行。
 */
function toView(row: SettingRow): SettingView {
  return {
    config_key: row.config_key,
    version_no: Number(row.version_no),
    value: valueFromPayload(row.payload),
    effective_from: toIso(row.effective_from),
  }
}

/**
 * 读一个设置键的当前生效行（effective_to is null；ORGANIZATION / scope_id=null）。
 * @param client - 只读事务内的连接。
 * @param tenantId - 租户（永远带，跨租户 = 不存在）。
 * @param configKey - config_key（调用方须来自 `WORKSPACE_SETTING_KEYS` 白名单）。
 * @returns 白名单投影；没有生效行返回 null（由调用方决定诚实缺省）。
 */
export async function readSetting(
  client: DatabaseClient,
  tenantId: string,
  configKey: string,
): Promise<SettingView | null> {
  const { rows } = await client.query<SettingRow>(
    `select ${SETTING_COLUMNS}
       from recruitment.business_config
      where tenant_id = $1::uuid
        and scope = $2
        and scope_id is null
        and config_key = $3
        and effective_to is null
      order by version_no desc
      limit 1`,
    [tenantId, ORGANIZATION_SCOPE, configKey],
  )
  const row = rows[0]
  return row === undefined ? null : toView(row)
}

/**
 * 读所有可写设置键的当前生效值（只 select 白名单列）。
 * @param client - 只读事务内的连接。
 * @param tenantId - 租户。
 * @param configKeys - 只读键白名单（调用方传 `WORKSPACE_SETTING_KEYS`）。
 * @returns 白名单投影数组（缺行 = 数组里没有该键；HTTP 层据此标 defaults_applied）。
 */
export async function readAllSettings(
  client: DatabaseClient,
  tenantId: string,
  configKeys: readonly string[],
): Promise<readonly SettingView[]> {
  if (configKeys.length === 0) return []
  const { rows } = await client.query<SettingRow>(
    // distinct on 保证"每个键只返回当前最大版本一行"：append-only 版本链不会关闭旧行
    // （effective_to 仍为 null），若不过滤，调用方 Map 会拿到重复键甚至旧值。
    `select distinct on (config_key) ${SETTING_COLUMNS}
       from recruitment.business_config
      where tenant_id = $1::uuid
        and scope = $2
        and scope_id is null
        and config_key = any($3::text[])
        and effective_to is null
      order by config_key asc, version_no desc`,
    [tenantId, ORGANIZATION_SCOPE, [...configKeys]],
  )
  return rows.map(toView)
}

/**
 * 追加一个新版本行（**绝不 UPDATE 旧行**）。
 *
 * 版本约定（照 `insertEmailAuthorization`）：
 *   * version_no = max(version_no) + 1（无旧版 = 1）；
 *   * effective_from = 旧最大版本 effective_to + 1ms（旧版未封顶/无旧版 = now()）。
 *
 * 必须在 `withActor(pool, actorId, ...)` 事务内调用（created_by_actor_id 外键 + GUC）。
 * @param client - 事务内连接（actor GUC 已设）。
 * @param input - 见 {@link AppendSettingVersionInput}。
 * @returns `{config_key, version_no, changed_from, effective_from}`（无内部 id）。
 */
export async function appendSettingVersion(
  client: DatabaseClient,
  input: AppendSettingVersionInput,
): Promise<AppendSettingVersionResult> {
  const maxResult = await client.query<MaxVersionRow>(
    `select version_no, effective_to
       from recruitment.business_config
      where tenant_id = $1::uuid and scope = $2 and scope_id is null and config_key = $3
      order by version_no desc
      limit 1`,
    [input.tenantId, ORGANIZATION_SCOPE, input.configKey],
  )
  const previous = maxResult.rows[0]
  const versionNo = previous === undefined ? 1 : Number(previous.version_no) + 1
  // changed_from 取"当前生效值"：max 行只有 version_no/effective_to（刻意不读 payload，
  // 且历史上封顶过的 max 行未必是生效行），所以单独按 effective_to is null 读一次 payload。
  const current = await client.query<Pick<SettingRow, 'payload'>>(
    `select payload
       from recruitment.business_config
      where tenant_id = $1::uuid and scope = $2 and scope_id is null and config_key = $3
        and effective_to is null
      order by version_no desc
      limit 1`,
    [input.tenantId, ORGANIZATION_SCOPE, input.configKey],
  )
  const changedFromValue = current.rows[0] === undefined ? null : valueFromPayload(current.rows[0])

  let effectiveFrom: string
  const previousTo = previous?.effective_to == null ? null : new Date(previous.effective_to).getTime()
  if (previousTo !== null && Number.isFinite(previousTo)) {
    effectiveFrom = new Date(previousTo + 1).toISOString()
  } else {
    effectiveFrom = new Date().toISOString()
  }

  const payload: Record<string, unknown> = {
    value: input.value,
    confirmation_text_sha256: input.confirmationTextSha256,
    changed_from: changedFromValue,
    changed_to: input.value,
    updated_by_actor_id: input.actorId,
  }
  const payloadHash = digestOf(payload)

  const inserted = await client.query(
    `insert into recruitment.business_config
       (tenant_id, scope, scope_id, config_key, version_no, payload, payload_hash,
        effective_from, effective_to, created_by_actor_id)
     values ($1::uuid, $2, null, $3, $4, $5::jsonb, $6, $7::timestamptz, null, $8::uuid)
     returning version_no`,
    [
      input.tenantId, ORGANIZATION_SCOPE, input.configKey, versionNo,
      JSON.stringify(payload), payloadHash, effectiveFrom, input.actorId,
    ],
  )
  if (inserted.rows[0] === undefined) {
    throw new Error('INVARIANT_VIOLATION: {"reason_code":"SETTING_INSERT_NO_ROW","message":"追加设置版本没有返回行。"}')
  }

  return {
    config_key: input.configKey,
    version_no: versionNo,
    changed_from: changedFromValue,
    effective_from: effectiveFrom,
  }
}
