// Demo Actor 的受控 alias 集合与 alias → HUMAN actor UUID 的映射解析。
//
// 设计口径（`work/d5/ACTOR-CONTRACT.md` §1、`work/d5/w1/CONTEXT.md` §1）：
//   * 浏览器**永远不提交 UUID**，只提交三个受控 alias 之一；
//   * alias → UUID 的映射只存在于**服务端受管配置**（插件配置 / 种子），
//     这里只负责"配置是否合法"，不负责"DB 里这个 actor 存不存在/是不是 HUMAN"
//     （那是 Host Remote Action 的 PUT /actor 与各写工具的职责）。
//   * A/B 是同一 INTERVIEWER 角色下的两个本地演示身份，不是认证系统、不是 RBAC。
//
// 本文件是**纯函数层**：不读环境变量、不落库、不落文件、不抛除
// `RecruitmentToolError('INVALID_ARGS')` 以外的错误。

import { RecruitmentToolError } from '../tools/errors.ts'
import { isUuidText } from '../db/pool.ts'

/** 受控 alias 封闭集（顺序即对外展示顺序，顺序本身不是契约，值是）。 */
export const DEMO_ACTOR_ALIASES = ['recruiter', 'interviewer_a', 'interviewer_b'] as const

/** 一个受控 alias。 */
export type DemoActorAlias = (typeof DEMO_ACTOR_ALIASES)[number]

/** alias → HUMAN actor UUID（可缺省；缺一个 = 该 alias 未映射 = 使用时 fail-closed）。 */
export type DemoActorMap = Readonly<Partial<Record<DemoActorAlias, string>>>

/** 插件配置里的 `demo_actor_map` 段（与 `DemoActorMap` 同形，单列是为了文档可检索）。 */
export type DemoActorMapConfig = Readonly<Partial<Record<DemoActorAlias, string>>>

/**
 * 缺省映射：与 `db/migrations/0002_seed.sql` 的演示账号一致。
 *
 *   * `recruiter`      = `…0103`（HR 专员 / 演示 recruiter）
 *   * `interviewer_a`  = `…0104`（演示-面试官 A）
 *   * `interviewer_b`  = `…0105`（演示-面试官 B；由 `scripts/bootstrap-demo.mjs` 幂等补齐）
 *
 * 这里只给缺省值；生产/其它租户应由插件配置显式覆盖（`resolveDemoActorMap`）。
 */
export const DEFAULT_DEMO_ACTOR_MAP: DemoActorMap = Object.freeze({
  recruiter: '11111111-1111-4111-8111-000000000103',
  interviewer_a: '11111111-1111-4111-8111-000000000104',
  interviewer_b: '11111111-1111-4111-8111-000000000105',
})

/** 配置值里允许出现的最大文本长度（超过的一律当非法，错误信息只截断展示）。 */
const MAX_CONFIG_VALUE_LENGTH = 128

/**
 * 是不是三个受控 alias 之一（**区分大小写**：alias 是服务端封闭集，不做归一）。
 * @param value - 任意值（来自 HTTP body / 配置 / 测试）。
 * @returns 是受控 alias 时为 `true`。
 */
export function isDemoActorAlias(value: unknown): value is DemoActorAlias {
  return typeof value === 'string' && (DEMO_ACTOR_ALIASES as readonly string[]).includes(value)
}

/**
 * 解析一个 alias；非法输入抛 `INVALID_ARGS`（**不猜、不归一**：`Recruiter` 也是非法）。
 * @param value - 任意值。
 * @returns 受控 alias。
 * @throws RecruitmentToolError - `INVALID_ARGS`（`UNKNOWN_ACTOR_ALIAS`）。
 */
export function parseDemoActorAlias(value: unknown): DemoActorAlias {
  if (isDemoActorAlias(value)) return value
  throw new RecruitmentToolError(
    'INVALID_ARGS',
    JSON.stringify({
      reason_code: 'UNKNOWN_ACTOR_ALIAS',
      alias: printable(value),
      allowed: [...DEMO_ACTOR_ALIASES],
    }),
  )
}

/**
 * 把插件配置里的映射解析成"只用合法 UUID"的映射。
 *
 * 规则（冻结口径）：
 *   * 缺省（`config === undefined` 或某个 alias 没给）= 取 `DEFAULT_DEMO_ACTOR_MAP`；
 *   * 显式给了 alias 就用显式值（显式值非法时**不回退默认**，而是进 `issues` 且该 alias 不进 map
 *     —— 配置写坏了要能被看见，不能静默拿默认值顶替）；
 *   * 值不是 UUID 文本 → `issues` + 该 alias 不进 map（使用时会 `DEMO_ACTOR_UNMAPPED`）；
 *   * 显式值的 UUID 统一转小写（与库里的文本形态对齐；UUID 比较本身大小写不敏感）。
 *
 * @param config - 插件配置的 `demo_actor_map`（可缺省）。
 * @returns `{map, issues}`：`issues` 非空不代表整个映射不可用，只代表那一个 alias 被剔除。
 */
export function resolveDemoActorMap(
  config?: DemoActorMapConfig,
): { map: DemoActorMap; issues: readonly string[] } {
  const issues: string[] = []
  const resolved: Partial<Record<DemoActorAlias, string>> = {}
  // 配置值来自 YAML/环境变量，运行时不保证是 TS 声明的形状：按 unknown 校验。
  const rawConfig = config as Readonly<Record<string, unknown>> | undefined
  for (const alias of DEMO_ACTOR_ALIASES) {
    const raw: unknown = rawConfig === undefined ? undefined : rawConfig[alias]
    if (raw === undefined) {
      const fallback = DEFAULT_DEMO_ACTOR_MAP[alias]
      if (fallback !== undefined) resolved[alias] = fallback
      continue
    }
    if (typeof raw !== 'string') {
      issues.push(`demo_actor_map.${alias} must be a UUID string (received ${typeof raw})`)
      continue
    }
    const value = raw.trim()
    if (value.length === 0 || value.length > MAX_CONFIG_VALUE_LENGTH || !isUuidText(value)) {
      issues.push(`demo_actor_map.${alias} must be a UUID string (received ${JSON.stringify(truncate(raw))})`)
      continue
    }
    resolved[alias] = value.toLowerCase()
  }
  return { map: Object.freeze(resolved), issues }
}

/**
 * 把任意值压成一段"可安全写进错误信息"的短文本（不猜测、不 JSON 序列化未知对象）。
 * @param value - 任意值。
 * @returns 最多 64 字符的描述。
 */
function printable(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return truncate(value)
  return `[${typeof value}]`
}

/**
 * 截断到 64 字符，避免把长文本/整段 YAML 回显到模型可见错误里。
 * @param text - 原文。
 * @returns 截断后的文本。
 */
function truncate(text: string): string {
  return text.length <= 64 ? text : `${text.slice(0, 64)}…`
}
