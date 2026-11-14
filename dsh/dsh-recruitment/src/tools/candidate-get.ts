// recruitment_candidate_get —— 按 id 取一个候选人档案（**真查 PG**，只读）。
//
// 2026-11-14 从 fixture stub 改成真库读：
//   * 旧版返回 `CANDIDATE_STUBS` 里写死的人，`stub=true`、`provenance=FIXTURE`；
//     产品里"查候选人"会给出一个编造的人 —— 这是假能力，不是占位。
//   * 新版只读 `recruitment.candidate` + `recruitment.application`（+ job 的 code/title），
//     租户只来自插件配置（`database.tenant_id`），模型无法传入。
//
// 三个诚实点（不许省）：
//   1. **PII**：联系方式默认脱敏；`include_contacts=true` 才返回原文，且输出里明确 `visible`。
//   2. **不编造**：查不到就 `NOT_FOUND`，绝不回退到样例数据。
//   3. **只读**：整段查询在 `begin transaction read only` 里（`withReadOnly`），
//      写语句会直接 25006，不靠"源码里没写 INSERT"这种自觉。
//
// 输出形状与旧版保持兼容的字段：`candidate_id` / `display_name` / `contacts` / `applications`；
// 去掉 `provenance`（stub 时代的概念）与 `status`（旧枚举是 ARCHIVED，与库里的 ACTIVE/MERGED 不符），
// 改成库里的 `identity_status` + `source: 'DATABASE'`。
//
// R4 三维标签（2026-11-14 补齐，`contracts/tenant-provenance.md`）：
//   旧版用一维的 `source:'DATABASE'` 代替三维标签；现在 `labels` 三轴齐全。
//   `source` 保留（它回答"从哪读的"），但**不能**再替代 `provenance`。
//
//   `resolveTenantProvenance()` 是**三个工具共用的一份判定**（本文件导出，job-create /
//   interview-schedule import 同一函数——"三处统一读同一判定"，不各写一份防漂移）：
//   `LIVE` 需要**正面证据**（租户被显式声明为非合成），否则 `FIXTURE`（fail-closed）。
//   把"真的写进了库 / 真的读到了库"当 `LIVE` 是错的：演示租户的合成数据同样真的在库里，
//   那正是 `docs/23` P2-03 里 "Fixture 冒充 LIVE" 的入口。

import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  closePool,
  createPool,
  isUuidText,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'

/** 工具名（index.ts 与测试都按这个名字找）。 */
const TOOL_NAME = 'recruitment_candidate_get'

/** 租户合成声明的配置键（`contracts/tenant-provenance.md` §2）。 */
const TENANT_PROVENANCE_CONFIG_KEY = 'tenant_provenance'
/** 阶段目录配置键：`payload.demo=true` 是 0002_seed 写下的合成标记。 */
const STAGE_CATALOG_CONFIG_KEY = 'stage_catalog'

/**
 * R4 · `provenance` 的唯一判定式（**三个工具共用这一份实现**，见 `contracts/tenant-provenance.md`）。
 *
 * ```text
 * provenance = 'LIVE'
 *   ⟺ 租户行存在
 *      ∧ 该租户在 business_config 里被**显式声明为非合成**
 *        （config_key='tenant_provenance' 的最新一版 payload->>'synthetic' = 'false'）
 *      ∧ 没有任何合成标记（config_key='stage_catalog' 的最新一版 payload->>'demo' ≠ 'true'）
 *   否则 'FIXTURE'   // 缺租户行 / 缺声明 / 有合成标记 —— 一律 fail-closed
 * ```
 *
 * 为什么不是"真的写进/读到了业务库就算 LIVE"：演示租户（`ra_s6s7` / `0002_seed`）里的合成数据
 * 同样"真的在库里"，按那条口径会把它标成 LIVE —— 这就是 `docs/23` P2-03 的"Fixture 冒充 LIVE"。
 * 为什么不是"没有外部系统就 FIXTURE"：那会把两个正交维度（数据真假 / 能否自己读写外部系统）
 * 压成一维，是 R4 的原始事故；能不能读外部系统由 `connection` 回答（本文件的三个工具都是
 * `NOT_CONNECTED`，见各自的工具契约）。
 *
 * @param client - 事务内客户端（业务库；`recruitment.business_config` / `organization` 只读）。
 * @param tenantId - 租户（只来自插件配置，模型无法传入）。
 * @returns `LIVE` 仅当有正面证据；其余一律 `FIXTURE`。
 */
export async function resolveTenantProvenance(
  client: DatabaseClient,
  tenantId: string,
): Promise<'LIVE' | 'FIXTURE'> {
  const { rows } = await client.query<{
    tenant_exists: boolean
    demo: string | null
    synthetic: string | null
  }>(
    // 每个 config_key 只取最新版本：`uq_business_config` 允许同键多版本，旧版本不得覆盖新版本。
    `with latest as (
       select distinct on (config_key) config_key, payload
         from recruitment.business_config
        where tenant_id = $1 and scope = 'ORGANIZATION'
        order by config_key, version_no desc
     )
     select
       exists (select 1 from recruitment.organization where id = $1) as tenant_exists,
       (select payload->>'demo' from latest where config_key = $2) as demo,
       (select payload->>'synthetic' from latest where config_key = $3) as synthetic`,
    [tenantId, STAGE_CATALOG_CONFIG_KEY, TENANT_PROVENANCE_CONFIG_KEY],
  )
  const row = rows[0]
  if (row === undefined || row.tenant_exists !== true) return 'FIXTURE'
  if (row.demo === 'true') return 'FIXTURE'
  if (row.synthetic === 'false') return 'LIVE'
  return 'FIXTURE'
}

/** 三维标签（R4；取值是封闭集合，不加第四种）。 */
export interface ThreeAxisLabels {
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly trigger: 'MANUAL'
  readonly connection: 'NOT_CONNECTED'
}

/**
 * 造本工具的三维标签：`provenance` 由 {@link resolveTenantProvenance} 算，其余两轴是常量。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @returns 三维标签。
 */
export async function buildThreeAxisLabels(
  client: DatabaseClient,
  tenantId: string,
): Promise<ThreeAxisLabels> {
  return {
    provenance: await resolveTenantProvenance(client, tenantId),
    // 模型/人在会话里调用；本工具不被事件驱动。
    trigger: 'MANUAL',
    // 本工具不调用任何外部系统（不读飞书、不读日历），只读本产品自己的业务库。
    connection: 'NOT_CONNECTED',
  }
}

/** 入参声明。 */
const PARAMS: ParamMap = {
  candidate_id: {
    kind: 'string',
    required: true,
    maxLength: 64,
    description: 'Candidate UUID (recruitment.candidate.id). Non-empty, at most 64 characters.',
  },
  include_contacts: {
    kind: 'boolean',
    description:
      'When true, return full email/phone (PII). Defaults to false, which masks both. '
      + 'Only set it when the caller is allowed to see personal contact data.',
  },
}

/** `recruitment.candidate` 的一行（只取用得到的列）。 */
interface CandidateRow {
  readonly id: string
  readonly display_name: string
  readonly normalized_email: string | null
  readonly normalized_phone: string | null
  readonly identity_status: string
  readonly merged_into_candidate_id: string | null
  readonly record_version: number
}

/** 一条申请关系（连带岗位的 code/title，方便 HR 直接看懂）。 */
interface ApplicationRow {
  readonly id: string
  readonly job_id: string
  readonly job_code: string | null
  readonly job_title: string | null
  readonly current_stage_code: string
  readonly lifecycle_status: string
}

/** 输出：联系方式（永远带 visible，避免"看着像原文其实是脱敏"的误读）。 */
interface Contacts {
  readonly visible: boolean
  readonly email: string
  readonly phone: string
}

/** 输出：一条申请关系。 */
interface ApplicationValue {
  readonly application_id: string
  readonly job_id: string
  readonly job_code: string
  readonly job_title: string
  readonly stage_code: string
  readonly lifecycle_status: string
}

/** 输出：规范值。 */
interface CandidateGetValue {
  readonly candidate_id: string
  readonly display_name: string
  readonly identity_status: string
  /** 只在 MERGED 且确实指向另一行时出现（DSH 输出 schema 没有 null，所以用"缺键"表达）。 */
  readonly merged_into_candidate_id?: string
  readonly record_version: number
  /** R4 三维标签（`contracts/tenant-provenance.md`）；**不是** `source` 的替代品。 */
  readonly labels: ThreeAxisLabels
  readonly source: 'DATABASE'
  readonly contacts: Contacts
  readonly applications: readonly ApplicationValue[]
}

/** 规范输出 schema（只用官方强制子集里的关键字；不用 type 数组、不用 null）。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    candidate_id: { type: 'string' },
    display_name: { type: 'string' },
    identity_status: { type: 'string', enum: ['ACTIVE', 'MERGED'] },
    merged_into_candidate_id: { type: 'string' },
    record_version: { type: 'number' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        // 本工具不接任何外部系统：唯一如实取值是 NOT_CONNECTED（枚举里不放 CONNECTED）。
        connection: { type: 'string', enum: ['NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    source: { type: 'string', enum: ['DATABASE'] },
    contacts: {
      type: 'object',
      properties: {
        visible: { type: 'boolean' },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['visible', 'email', 'phone'],
      additionalProperties: false,
    },
    applications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          application_id: { type: 'string' },
          job_id: { type: 'string' },
          job_code: { type: 'string' },
          job_title: { type: 'string' },
          stage_code: { type: 'string' },
          lifecycle_status: {
            type: 'string',
            enum: ['ACTIVE', 'ON_HOLD', 'WITHDRAWN', 'CLOSED'],
          },
        },
        required: ['application_id', 'job_id', 'job_code', 'job_title', 'stage_code', 'lifecycle_status'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'candidate_id', 'display_name', 'identity_status', 'record_version', 'labels', 'source',
    'contacts', 'applications',
  ],
  additionalProperties: false,
}

/**
 * 邮箱脱敏：保留首字母与域名。
 * @param email - 原始邮箱；空串原样返回。
 * @returns 脱敏后的邮箱。
 */
function maskEmail(email: string): string {
  if (email === '') return ''
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

/**
 * 手机号脱敏：保留前 3 位与后 4 位。
 * @param phone - 原始号码；空串原样返回。
 * @returns 脱敏后的号码。
 */
function maskPhone(phone: string): string {
  if (phone === '') return ''
  const digits = phone.replace(/[^0-9]/g, '')
  if (digits.length < 8) return '***'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/**
 * 在只读事务里取候选人档案。
 * @param client - 只读事务连接。
 * @param cfg - 已解析的库配置（租户只从这里来）。
 * @param args - 已校验的入参。
 * @returns 规范输出值。
 */
export async function readCandidateValue(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
): Promise<CandidateGetValue> {
  const candidateId = args.candidate_id as string

  const candidateResult = await client.query<CandidateRow>(
    `select id, display_name, normalized_email, normalized_phone,
            identity_status, merged_into_candidate_id, record_version
       from recruitment.candidate
      where id = $1 and tenant_id = $2`,
    [candidateId, cfg.tenant_id],
  )
  const candidate = candidateResult.rows[0]
  if (candidate === undefined) {
    throw new RecruitmentToolError(
      'NOT_FOUND',
      JSON.stringify({ reason_code: 'CANDIDATE_NOT_FOUND', candidate_id: candidateId }),
    )
  }

  const applicationResult = await client.query<ApplicationRow>(
    `select a.id, a.job_id, j.code as job_code, j.title as job_title,
            a.current_stage_code, a.lifecycle_status
       from recruitment.application a
       left join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
      where a.tenant_id = $1 and a.candidate_id = $2
      order by a.created_at, a.id`,
    [cfg.tenant_id, candidateId],
  )

  const visible = args.include_contacts === true
  const email = candidate.normalized_email ?? ''
  const phone = candidate.normalized_phone ?? ''
  // R4：三维标签由库里的租户合成标记算出（不是写死；演示租户 ⇒ FIXTURE）。
  const labels = await buildThreeAxisLabels(client, cfg.tenant_id)

  const value: CandidateGetValue = {
    candidate_id: candidate.id,
    display_name: candidate.display_name,
    identity_status: candidate.identity_status,
    record_version: candidate.record_version,
    labels,
    source: 'DATABASE',
    contacts: {
      visible,
      email: visible ? email : maskEmail(email),
      phone: visible ? phone : maskPhone(phone),
    },
    applications: applicationResult.rows.map((row) => ({
      application_id: row.id,
      job_id: row.job_id,
      job_code: row.job_code ?? '',
      job_title: row.job_title ?? '',
      stage_code: row.current_stage_code,
      lifecycle_status: row.lifecycle_status,
    })),
  }
  // MERGED 但没有指向目标 = 脏数据；此时不编造一个 id，只保留 identity_status 让调用方看见异常。
  if (candidate.identity_status === 'MERGED' && candidate.merged_into_candidate_id !== null) {
    return { ...value, merged_into_candidate_id: candidate.merged_into_candidate_id }
  }
  return value
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED。
 * @param issues - 缺失的配置项。
 * @returns 调用即抛错的工具定义。
 */
export function unconfiguredCandidateGetTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Get one candidate profile by id from the business database. Currently NOT CONFIGURED: '
      + `${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError('NOT_CONFIGURED', issues.join('; '))
    },
  }
}

/**
 * 造真实的候选人查询工具。
 * @param config - 已解析的库配置（租户/连接只从这里来，模型无法传入）。
 * @returns 工具定义。
 */
export function createCandidateGetTool(config: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Get one candidate profile by id, read straight from the business database '
      + '(source=DATABASE, read-only). Returns display_name, identity_status (ACTIVE/MERGED), '
      + 'record_version, masked contacts, and every application of this candidate with its '
      + 'job code/title, stage_code and lifecycle_status. Contacts are masked unless '
      + 'include_contacts is true (PII). Returns NOT_FOUND for an unknown id — it never falls '
      + 'back to sample data. Output carries R4 three-axis labels: labels.provenance is computed '
      + 'from the tenant\'s synthetic marker (FIXTURE unless the tenant is explicitly declared '
      + 'non-synthetic), labels.trigger is MANUAL, labels.connection is NOT_CONNECTED because no '
      + 'external system is read.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as CandidateGetValue
        const lines: string[] = [
          `candidate ${v.candidate_id} / ${v.display_name} `
            + `(identity_status=${v.identity_status}, record_version=${v.record_version}, source=${v.source})`,
          `  labels: ${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`,
        ]
        if (v.merged_into_candidate_id !== undefined) {
          lines.push(`  merged_into_candidate_id=${v.merged_into_candidate_id}`)
        }
        lines.push(
          `  contacts: ${v.contacts.email} / ${v.contacts.phone} (visible=${String(v.contacts.visible)})`,
        )
        lines.push(`  applications: ${v.applications.length}`)
        for (const application of v.applications) {
          lines.push(
            `    ${application.application_id} -> ${application.job_code} ${application.job_title} `
              + `@ ${application.stage_code} (${application.lifecycle_status})`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseArgs(PARAMS, rawArgs)
      const candidateId = args.candidate_id as string
      if (!isUuidText(candidateId)) {
        throw new RecruitmentToolError(
          'INVALID_ARGS',
          JSON.stringify({ reason_code: 'NOT_A_UUID', path: 'candidate_id', value: candidateId }),
        )
      }
      const pool = createPool(config)
      try {
        return await withReadOnly(pool, async (client) => readCandidateValue(client, config, args))
      } finally {
        await closePool(pool)
      }
    },
  }
}
