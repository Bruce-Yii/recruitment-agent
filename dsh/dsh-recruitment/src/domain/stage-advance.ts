// 阶段推进的领域实现（复审 N8 / 方案 D：**派生式推进命令**）。
//
// 一句话：本命令**不新增任何授权**，只把"已经发生的事实"翻译成一次阶段指针前移。
//
//   * 事实 → 指针：
//       T1  S6 → S7：申请已绑定材料（`resume_version_id` 非空）、材料的 `parse_status`
//           不是 `FAILED`、且已钉住 rubric 版本（`rubric_version_id` 非空）。
//       T2  S7 → S8：存在 **current**（`superseded_by_decision_id is null`）的
//           `decision(decision_scope='SCREENING', result='ADVANCE')`。
//   * 没有事实就没有推进（NO_OP）；有**反向事实**（SCREENING 结果是 HOLD/REJECT、
//     材料解析失败、rubric 未钉）就是 BLOCKED —— 并给出可执行的下一步。
//   * 不接受目标阶段、不接受 actor、不写 decision、不建任务：那些不是"承认事实"，
//     而是"下命令"。命令入口一旦存在，模型就能绕过人（D-79 / D-95 的人机闸门形同虚设）。
//
// 【F1 · rubric 补钉（本文件唯一的业务写入，T1 前置的一部分）】
//
//   `application.rubric_version_id` 有两个写入时机，缺一不可：
//     1. **intake 建申请时**（`application-intake.ts`）：当时岗位已有已批准的 current ⇒ 直接钉；
//     2. **本命令的 T1 判定**（补钉）：申请早于 rubric 批准（先接简历、后批标准，这是常态），
//        `rubric_version_id` 为空而岗位此刻已有**已批准**的 `job.current_rubric_version_id`。
//
//   补钉的边界（写死，别扩）：
//     * **只在 T1 的唯一缺口是这个 rubric 时**才补（还有材料问题 → 一行都不写，BLOCKED）；
//     * 只认 `job.current_rubric_version_id`（D-21），并**当场复核它已批准**（D-48 不回退推导）；
//     * 在同一事务里写 `application.rubric_version_id` + 一条内部审计事件
//       （`application.rubric_version.pinned`，含 actor / 原因 / 新旧指针），
//       然后才走阶段 UPDATE —— 任一步失败整体回滚；
//     * UPDATE 必须是条件写（`rubric_version_id is null`）并经过 `fn_row_guard`
//       （调用方已 `SET LOCAL recruitment.actor_id`，actor 缺失直接拒绝，不做匿名写入）；
//     * **只读视图不补钉**：`readStageBlockedView` 走 `allowPin=false`，一条写语句都不发，
//       仍按"当前事实"报 `RUBRIC_NOT_PINNED`。视图与写路径的这点差异是刻意的：
//       视图回答"库里现在缺什么"，写路径回答"这次调用能不能把事实补齐后推进"。
//     * 本命令**不**因此获得任何新授权：rubric 版本已经由人批准过，补钉只是把同一个
//       已批准事实记录到申请上（没有批准就没有可钉的版本）。
//
// 【v1.1 · §11.6-8 复审】阻塞不再只是自由文本：
//   * `blockers[]` / `warnings[]` 的每一项都带**结构化的责任与下一步**：
//       `owner_role`（封闭集）、`next_action_code`（封闭集）**恒有**；
//       `owner_actor_id` / `owner_display_name` 只在**能从库里推出来**时出现。
//     —— 工作台因此可以机检「阻塞原因 + 责任人 + 下一步」，而不是解析一句话。
//   * 责任人的推导链（本仓没有 job 级 owner 列，只有部门级）：
//       application → job → department.hiring_manager_actor_id（招聘负责人）
//       SCREENING 反向事实 → decision.decided_by_actor_id（真的做过这个决定的人）
//     推不出来就**省略 actor 字段**，但 `owner_role` + `next_action_code` 仍然给出"该找谁"。
//   * 新增只读的 {@link readStageBlockedView}：同一套判定，但**不加行锁、不写任何东西**
//     （可安全跑在 `withReadOnly` 事务里），给工作台直接渲染 `{stage, blockers, owner, next_action}`。
//     `blockers[]` 里用 `kind: 'BLOCKER' | 'WARNING'` 区分"真的挡住了"和"只是告警（STAGE_AHEAD）"。
//
// 三条最容易踩的库级事实（都实测过；契约见 `contracts/stage-advance/tool-contracts.md`）：
//
//   1. `application.current_stage_code` 上挂着 `fn_row_guard('current_stage_code','stage')`
//      （`db/migrations/0001_init.sql:1747`；实测触发器名 `trg_application_guard_current_stage_code`）：
//        · `record_version` 由触发器 +1 —— **调用方不许手写**（手写多半是重复自增，版本对不上）；
//        · 阶段**真的**变了 → 触发器自己往 `event_inbox` 插一条
//          `event_type='application.current_stage_code.changed'`，并回填
//          `stage_changed_at` / `stage_source_event_id` / `stage_changed_by_actor_id`
//          （actor 取 `SET LOCAL recruitment.actor_id`，即执行账号）；
//        · 阶段**没变** → 只把 `record_version` +1、`updated_at` 改成 now()。
//          所以"零 UPDATE"必须靠**不发 UPDATE**来保证：发一条"值相同"的 UPDATE 也会让
//          版本号白涨、审计被污染（幂等用例就是断言这一点）。
//
//   2. `stage_entered_at` 只有 `DEFAULT now()`（`0001_init.sql:846`），**`fn_row_guard`
//      不维护它** —— 这是本仓既有缺陷。不写它，"在当前阶段停留时长"永远等于"距创建时长"。
//      本文件在每次迁移时显式写它，并读回断言
//      `stage_entered_at > created_at`（写不进去就整体回滚，不静默放过）。
//      写入式子是 `greatest(clock_timestamp(), 旧值 + 1µs, created_at + 1µs)`：
//        · 不用 `now()` —— 它是**事务开始时间**，同一事务里创建的申请会让两者相等，断言失去意义；
//        · 不裸用 `clock_timestamp()` —— 时钟粒度可能粗到毫秒（Windows 实测两跳会拿到同一个 tick），
//          多跳时"严格单调"会变成靠运气。`+1µs` 是**精度下限**，把单调性变成构造出来的事实。
//
//   3. `application` 上还有第二个 `fn_row_guard('lifecycle_status','status')` 与 `0009` 的
//      周期守卫。它们在我们这条 UPDATE 上只会走"状态未变 → 版本自增"分支：不写事件、
//      不动 `*_changed_at`、不会挡路。
//
// 事务与并发（工具层必须按这个顺序用）：
//   * 写路径的调用方必须**已经在一个事务里**，且已 `SET LOCAL recruitment.actor_id`
//     （`src/db/pool.ts` 的 `withActor` 就做这两件事）——否则 `fn_row_guard` 会以
//     `ACTOR_REQUIRED`（23514）拒绝，而不是"匿名写入"。
//   * 写路径开头 `select … for update` 拿行锁；每条 UPDATE 再带 `current_stage_code` +
//     `record_version` 条件，0 行 → `VERSION_CONFLICT`（重读后再决定，不 last-write-wins）。
//   * READ COMMITTED 下第二个调用者被行锁串行化：等锁结束后看到的是新状态 → `NO_OP`。
//     REPEATABLE READ / SERIALIZABLE 下 PostgreSQL 会抛 `40001`（concurrent update），
//     本文件把它（与 `40P01` 死锁）映射成同一个 `VERSION_CONFLICT`：并发修改的正确反应
//     是"重读"，不是"再写一次"。
//   * 一次调用允许多跳（落后补推进）：S6 同时满足 T1/T2 时依次发两条 UPDATE，
//     **一条边一条事件**；整个调用在调用方的事务里，任一跳失败 → 全部回滚（不会半推进）。
//
// 不做什么（与方案 D 的边界一致）：
//   * 不接受 `to_stage` / `actor_id` / `tenant_id` 入参（身份与目标都只能来自事实与配置）；
//   * 不写 `decision`、不建 `business_task`、不改 `lifecycle_status`、不写 `stage_blocked_reason`；
//   * **唯一的例外**是 T1 的 rubric 补钉（`application.rubric_version_id`，见文件头 F1）——
//     它写的是一个已经由人批准过的事实，不是本命令新造的授权；
//   * 不倒退（指针已超前于本命令能推导的事实 → `STAGE_AHEAD` 警告 + 一条 UPDATE 都不发）；
//   * 不跳阶（只走 S6→S7→S8 两条边；中间任一前置不成立就停在那一步）。

import { randomUUID } from 'node:crypto'

import { canonicalJson } from '../tools/contract.ts'
import { RecruitmentToolError } from '../tools/errors.ts'
import type { DatabaseClient } from '../db/pool.ts'

// =====================================================================
//  公开形状（工具层照着它出参；没有 null —— DSH 校验器不支持 type 数组）
// =====================================================================

/** 一次调用的结论（三态封闭集）。 */
export type StageAdvanceStatus = 'ADVANCED' | 'NO_OP' | 'BLOCKED'

/** `blockers[].code` 的封闭集（每一种都给可执行的下一步，见各分支 message）。 */
export const BLOCKER_CODES = [
  // T1 前置（S6 → S7）
  'MATERIAL_NOT_LINKED',
  'MATERIAL_PARSE_FAILED',
  'RUBRIC_NOT_PINNED',
  // 申请本身不在推进范围
  'APPLICATION_NOT_ACTIVE',
  'STAGE_NOT_ON_LADDER',
  // T2 反向事实（S7 → S8）
  'SCREENING_DECISION_NOT_ADVANCE',
] as const

/** 一条 blocker 的稳定码。 */
export type StageBlockerCode = (typeof BLOCKER_CODES)[number]

/**
 * `owner_role` 的封闭集：**该找谁**。推导链见文件头（本仓只有部门级招聘负责人）。
 *
 *   * `JOB_HIRING_MANAGER` 岗位所属部门的招聘负责人（`department.hiring_manager_actor_id`）；
 *   * `RECRUITMENT_OWNER`  招聘负责人（材料/申请周期这类"招聘侧该收拾"的事）；
 *   * `SCREENING_DECIDER`  做过 current SCREENING 决策的那个人（`decision.decided_by_actor_id`）；
 *   * `PLATFORM_OPERATOR`  平台/数据面（本命令当前不产生这种 owner，保留给下游扩展）。
 */
export const OWNER_ROLES = [
  'JOB_HIRING_MANAGER',
  'RECRUITMENT_OWNER',
  'SCREENING_DECIDER',
  'PLATFORM_OPERATOR',
] as const

/** 责任角色的稳定码。 */
export type StageOwnerRole = (typeof OWNER_ROLES)[number]

/**
 * `next_action_code` 的封闭集：**下一步做什么**（机检用；人读的句子在 `message` 与
 * `NEXT_ACTION_MESSAGES`）。每一种都有确定的动作，不是自由文本。
 */
export const NEXT_ACTION_CODES = [
  'PIN_RUBRIC_VERSION',
  'LINK_INTAKE_MATERIAL',
  'REPARSE_MATERIAL',
  'RECORD_SCREENING_DECISION',
  'SUPERSEDE_SCREENING_DECISION',
  'REOPEN_APPLICATION',
  'START_AT_INTAKE',
  'VERIFY_STAGE_PROGRESSION',
  'ADVANCE_STAGE',
  'CONTINUE_DOWNSTREAM',
] as const

/** 下一步动作的稳定码。 */
export type StageNextActionCode = (typeof NEXT_ACTION_CODES)[number]

/**
 * 下一步动作的人读说明（与 code 一一对应；code 才是机检口径）。
 * 表里每一行都必须回答"谁、做什么、做完这一条还差什么"。
 */
export const NEXT_ACTION_MESSAGES: Readonly<Record<StageNextActionCode, string>> = {
  PIN_RUBRIC_VERSION: '批准岗位的一个 rubric 版本（recruitment_job_rubric_approve 会同时把 job.current_rubric_version_id 指过去），再调用 recruitment_application_stage_advance：写路径会在同一事务里把该版本钉到申请上。若申请已钉、只是岗位换了当前版本，同样先批准再推进。',
  LINK_INTAKE_MATERIAL: '跑一次 recruitment_application_intake，把候选人的材料绑定到这条申请上。',
  REPARSE_MATERIAL: '修复或重新导入材料（parse_status 不能是 FAILED），再重试推进。',
  RECORD_SCREENING_DECISION: '由人完成初筛并落一条 SCREENING 决策（recruitment_decision_record），再重试推进。',
  SUPERSEDE_SCREENING_DECISION: '若结论需要改，由人做一次新的 SCREENING 决策取代当前这条，再重试推进。',
  REOPEN_APPLICATION: '申请已不在 ACTIVE：确认是否需要重开/重新建档（不在本命令范围）。',
  START_AT_INTAKE: '先用 intake 把申请带到 S6；本命令只覆盖 S6→S7→S8。',
  VERIFY_STAGE_PROGRESSION: '核对这次阶段推进是谁做的：本命令不倒退；S9 之后的推进由面试/评价线负责。',
  ADVANCE_STAGE: '事实已齐：调用 recruitment_application_stage_advance 推进。',
  CONTINUE_DOWNSTREAM: '本命令已无剩余动作：后续由面试/评价线推进。',
}

/**
 * 一条阻塞/告警的**责任与下一步**（v1.1 起是结构化的，不再只有自由文本）。
 *
 * `owner_role` 与 `next_action_code` **恒有**（封闭集）——所以"至少有一个非空"不是靠
 * 调用方自觉，而是类型层的保证；`owner_actor_id` 只在能从库里推出来时出现。
 */
export interface StageResponsibility {
  /** 该找谁（封闭集，恒有）。 */
  readonly owner_role: StageOwnerRole
  /** 下一步做什么（封闭集，恒有）。 */
  readonly next_action_code: StageNextActionCode
  /** 具体责任人（UUID）。能从库里推出来才有；推不出来就省略。 */
  readonly owner_actor_id?: string
  /** 责任人显示名（来自 `recruitment.actor.display_name`；方便工作台直接渲染）。 */
  readonly owner_display_name?: string
}

/** 一条挡住推进的原因（`message` 说明缺什么；责任与下一步在结构化字段里）。 */
export interface StageBlocker extends StageResponsibility {
  readonly code: StageBlockerCode
  readonly message: string
}

/** `warnings[].code` 的封闭集。 */
export const WARNING_CODES = ['STAGE_AHEAD'] as const

/** 一条警告的稳定码。 */
export type StageWarningCode = (typeof WARNING_CODES)[number]

/**
 * 一条警告。`STAGE_AHEAD` = 指针已经超过本命令能推导的事实（最多到 S8）：
 * 本命令**一条 UPDATE 都不发**，把决定权留给真正的上游（面试/评价线）。
 */
export interface StageWarning extends StageResponsibility {
  readonly code: StageWarningCode
  readonly message: string
}

/** 工作台用的统一"阻塞视图条目"：blocker 与 warning 同一形状，`kind` 区分。 */
export interface StageObstruction extends StageResponsibility {
  readonly kind: 'BLOCKER' | 'WARNING'
  readonly code: StageBlockerCode | StageWarningCode
  readonly message: string
}

/** 已经真实发生的阶段迁移（`transitions[]` 的元素；只有 ADVANCED 时非空）。 */
export interface StageTransition {
  readonly from: string
  readonly to: string
}

/** `advanceApplicationStage` 的返回值（契约的六个字段 + 本实现必须补的 warnings）。 */
export interface StageAdvanceResult {
  /** 申请 id（回显）。 */
  readonly application_id: string
  /** 调用结束后的当前阶段码（NO_OP / BLOCKED 时=调用前的值）。 */
  readonly stage_code: string
  /** 调用结束后的 `record_version`（没发 UPDATE 就与调用前相同）。 */
  readonly record_version: number
  /** 三态结论。 */
  readonly status: StageAdvanceStatus
  /** 真实应用的迁移（按顺序；多跳时两条）。 */
  readonly transitions: readonly StageTransition[]
  /** 挡住推进的原因（BLOCKED 时非空；ADVANCED 时可能带"为什么停在下一跳"）。 */
  readonly blockers: readonly StageBlocker[]
  /** 警告（目前只有 `STAGE_AHEAD`）。 */
  readonly warnings: readonly StageWarning[]
}

/** 本命令的输入：租户来自配置、申请来自入参，**没有第三个**。 */
export interface AdvanceApplicationStageInput {
  readonly tenantId: string
  readonly applicationId: string
}

/** 工作台视角的"责任人"（`role` 恒有；actor 能推出来才有）。 */
export interface StageOwner {
  readonly role: StageOwnerRole
  readonly actor_id?: string
  readonly display_name?: string
}

/** 工作台视角的"下一步"（`code` 恒有；人读说明与责任角色一起带上）。 */
export interface StageNextAction {
  readonly code: StageNextActionCode
  readonly message: string
  readonly owner_role: StageOwnerRole
  readonly owner_actor_id?: string
}

/**
 * 只读的「阻塞视图」（给工作台直接用；**不新表、不加锁、不写库**）。
 *
 * 形状对应 Notion `08 §11.6` 第 8 条的四要素：
 *   `stage`（当前状态）+ `blockers[]`（阻塞原因，每条自带 owner/next_action）
 *   + `owner` / `next_action`（整条申请级别的"找谁、做什么"）。
 */
export interface StageBlockedView {
  readonly application_id: string
  /** 当前阶段码（S1–S12）。 */
  readonly stage: string
  /** 阶段名（`stage_catalog.name`，给 HR 直接读）。 */
  readonly stage_name: string
  readonly lifecycle_status: string
  readonly record_version: number
  /** 与推进命令同一套三态（READY→ADVANCED / 等人→NO_OP / 被挡→BLOCKED）。 */
  readonly status: StageAdvanceStatus
  /** 真的被挡住了吗（`STAGE_AHEAD` 是告警，不算 blocked）。 */
  readonly blocked: boolean
  /** 所有阻塞 + 告警（统一形状，`kind` 区分）；每条都带 owner_role / next_action_code。 */
  readonly blockers: readonly StageObstruction[]
  /** 整条申请的责任人（取优先级最高的一条；role 恒有）。 */
  readonly owner: StageOwner
  /** 整条申请的下一步（取优先级最高的一条；code 恒有）。 */
  readonly next_action: StageNextAction
}

// =====================================================================
//  迁移梯子（唯一真相：只有这两条边；顺序 = 执行顺序）
// =====================================================================

/** 梯子的一条边（S 级阶段码；`rule` 只用于注释/契约对照，不进输出）。 */
interface StageEdge {
  readonly from: string
  readonly to: string
  readonly rule: 'T1' | 'T2'
}

/** 只承认的两条边（T1 / T2）。**顺序即执行顺序**；遍历的唯一真相是这个数组。 */
const LADDER: readonly StageEdge[] = [
  { from: 'S6', to: 'S7', rule: 'T1' },
  { from: 'S7', to: 'S8', rule: 'T2' },
]

/** S1–S12 的阶段码里，本命令只覆盖这三格（由梯子本身派生，不另写一份）。 */
const LADDER_START = LADDER[0]?.from ?? 'S6'
const LADDER_TERMINAL = LADDER[LADDER.length - 1]?.to ?? 'S8'

// =====================================================================
//  错误（本文件自己构造；`tools/errors.ts` 的联合里没有 VERSION_CONFLICT，沿用
//  decision-record.ts 的局部构造器做法——message 仍是 `CODE: compact-json`）
// =====================================================================

/**
 * 本文件允许抛出的错误码（其余一律是库/宿主异常，原样上抛）。
 * `INVALID_ARGS` 只用于 F1 补钉前"执行上下文没有 actor"这一类**调用前提**缺失（不写匿名审计）。
 */
type StageAdvanceErrorCode = 'NOT_FOUND' | 'VERSION_CONFLICT' | 'INVARIANT_VIOLATION' | 'INVALID_ARGS'

/**
 * 造一个 `Error: <CODE>: <compact-json>` 形态的工具错误。
 * @param code - 稳定错误码。
 * @param reasonCode - 该码下的封闭取值。
 * @param message - 一句中文说明（不含 PII）。
 * @param detail - 结构化明细；没有就省略键（契约禁止用 null 占位）。
 * @returns 可直接 throw 的错误实例。
 */
function stageError(
  code: StageAdvanceErrorCode,
  reasonCode: string,
  message: string,
  detail?: Record<string, unknown>,
): RecruitmentToolError {
  const body: Record<string, unknown> = { code, reason_code: reasonCode, message }
  if (detail !== undefined) body.detail = detail
  // `errors.ts` 的联合是 S6/S7 那份封闭集（本 lane 不改它）→ 运行期 code 就是传入值。
  return new RecruitmentToolError(code as never, canonicalJson(body))
}

/**
 * 这是不是"并发修改"类错误？
 *
 *   * `40001` serialization_failure —— REPEATABLE READ / SERIALIZABLE 下 `select … for update`
 *     等锁后发现行已被并发事务改过；
 *   * `40P01` deadlock_detected —— 两个调用互相等锁时被数据库选中的一方。
 *
 * 两者都意味着"你读到的已经过期"，正确反应是**重读**（不是重写）→ 统一映射 `VERSION_CONFLICT`。
 * @param error - 任意异常。
 */
function isConcurrentUpdateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === '40001' || code === '40P01'
}

// =====================================================================
//  库读取（全部显式按 tenant_id 过滤；租户只来自配置）
// =====================================================================

/** 行锁（或普通读）到的申请（只取本判定要用的列）。 */
interface ApplicationRow {
  readonly id: string
  readonly current_stage_code: string
  readonly record_version: number
  readonly lifecycle_status: string
  readonly resume_version_id: string | null
  readonly rubric_version_id: string | null
  /**
   * `stage_entered_at` 的**微秒**表示（`extract(epoch …) * 1e6`）。
   * 为什么不在 JS 里用 `Date` 比较：JS 的 `Date` 只有毫秒精度，而本命令用 1µs 下限保证
   * 严格单调 —— 两跳只差 1µs 时 `Date` 会给出**相等**，断言就变成"看时钟粒度运气"。
   * `double precision` 在 1.7e15 量级上仍精确到 1µs（< 2^53），所以可以直接比较。
   */
  readonly stage_entered_at_us: number
  /** `created_at` 的微秒表示（同上）。 */
  readonly created_at_us: number
}

/** UPDATE 的 RETURNING（触发器处理后的真实值）。 */
interface UpdatedApplicationRow {
  readonly current_stage_code: string
  readonly record_version: number
  /** 见 `ApplicationRow.stage_entered_at_us`（微秒，不是毫秒）。 */
  readonly stage_entered_at_us: number
}

/** current SCREENING 决策（T2 的唯一事实源 + 责任人推导源）。 */
interface ScreeningDecisionRow {
  readonly id: string
  readonly result: string
  readonly decided_by_actor_id: string
  readonly decided_by_display_name: string | null
}

/** 阶段目录的一行（顺序 + 名字）。 */
interface StageCatalogEntry {
  readonly sort_order: number
  readonly name: string
}

/** 责任人（能推出来才有 actor；推不出来只有 role）。 */
interface ResolvedOwner {
  readonly actor_id?: string
  readonly display_name?: string
}

/**
 * 读申请。写路径 `lock=true` 时 `select … for update`：**行锁是串行化点**，并发的第二个
 * 调用在这里等，拿到锁时看到的一定是最新已提交状态；只读视图 `lock=false` 时退化成普通
 * `select`（因此可以安全跑在 `begin transaction read only` 里）。
 * @param client - 调用方事务内的连接。
 * @param tenantId - 租户（来自配置）。
 * @param applicationId - 申请 id。
 * @param lock - 是否加行锁（写路径 true / 只读视图 false）。
 * @returns 申请行。
 * @throws RecruitmentToolError - `NOT_FOUND`（不存在/不属于本租户）。
 */
async function readApplication(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  lock: boolean,
): Promise<ApplicationRow> {
  const { rows } = await client.query<ApplicationRow>(
    `select id, current_stage_code, record_version, lifecycle_status,
            resume_version_id, rubric_version_id,
            (extract(epoch from stage_entered_at) * 1000000)::double precision as stage_entered_at_us,
            (extract(epoch from created_at)       * 1000000)::double precision as created_at_us
       from recruitment.application
      where id = $1 and tenant_id = $2
      ${lock ? 'for update' : ''}`,
    [applicationId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw stageError(
      'NOT_FOUND',
      'APPLICATION_NOT_FOUND',
      '申请不存在，或不属于当前租户。',
      { application_id: applicationId },
    )
  }
  return row
}

/**
 * 读阶段目录（`sort_order` + `name`）。阶段顺序的**唯一权威**是 `recruitment.stage_catalog`，
 * 不是本文件里写死的数字；写死会让"目录改了、推进没改"变成静默错误。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param codes - 要取的阶段码（当前阶段 + 梯子两端）。
 * @returns 阶段码 → 目录行。
 */
async function readStageCatalog(
  client: DatabaseClient,
  tenantId: string,
  codes: readonly string[],
): Promise<Map<string, StageCatalogEntry>> {
  const { rows } = await client.query<{ code: string; sort_order: number; name: string }>(
    `select code, sort_order, name
       from recruitment.stage_catalog
      where tenant_id = $1 and code = any($2::text[])`,
    [tenantId, [...new Set(codes)]],
  )
  const catalog = new Map<string, StageCatalogEntry>()
  for (const row of rows) catalog.set(row.code, { sort_order: row.sort_order, name: row.name })
  return catalog
}

/**
 * 推导"招聘负责人"：`application → job → department.hiring_manager_actor_id`。
 * 本仓 `job` / `requisition` 都**没有** owner 列，只有部门有 → 这是唯一能从库里推出的链。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 * @returns 责任人；推不出来返回空对象（调用方据此省略 actor 字段）。
 */
async function resolveRecruitmentOwner(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ResolvedOwner> {
  const { rows } = await client.query<{ actor_id: string | null; display_name: string | null }>(
    `select d.hiring_manager_actor_id as actor_id,
            hm.display_name            as display_name
       from recruitment.application a
       join recruitment.job j
         on j.id = a.job_id and j.tenant_id = a.tenant_id
       left join recruitment.department d
         on d.id = j.department_id and d.tenant_id = j.tenant_id
       left join recruitment.actor hm
         on hm.id = d.hiring_manager_actor_id and hm.tenant_id = d.tenant_id
      where a.tenant_id = $1 and a.id = $2`,
    [tenantId, applicationId],
  )
  const row = rows[0]
  if (row === undefined || row.actor_id === null) return {}
  return {
    actor_id: row.actor_id,
    ...(row.display_name === null ? {} : { display_name: row.display_name }),
  }
}

/**
 * T1 的两条前置事实（材料、rubric）。**只判定、不写入**。
 *
 * rubric 的写入（补钉）不在这里：判定必须在只读视图里也能跑，而补钉是写路径的动作。
 * 调用方（{@link evaluateT1}）在"唯一缺口就是这个 rubric"且 `allowPin=true` 时才补。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param app - 读到的申请。
 * @returns 原始 blocker（责任角色/下一步已定，actor 待 enrich）。
 */
async function checkS6ToS7(
  client: DatabaseClient,
  tenantId: string,
  app: ApplicationRow,
): Promise<RawBlocker[]> {
  const blockers: RawBlocker[] = []
  if (app.resume_version_id === null) {
    blockers.push({
      code: 'MATERIAL_NOT_LINKED',
      message: '申请还没有绑定材料（resume_version_id 为空）：先跑 recruitment_application_intake '
        + '把材料落到这条申请上，再调用本命令。',
      owner_role: 'RECRUITMENT_OWNER',
      next_action_code: 'LINK_INTAKE_MATERIAL',
    })
  } else {
    // 材料 `parse_status` 是 resume_version 自己的列（0001:813）；只认 FAILED 为反向事实。
    const { rows } = await client.query<{ parse_status: string }>(
      `select parse_status
         from recruitment.resume_version
        where id = $1 and tenant_id = $2`,
      [app.resume_version_id, tenantId],
    )
    const material = rows[0]
    if (material === undefined) {
      blockers.push({
        code: 'MATERIAL_NOT_LINKED',
        message: '申请指向的材料版本在库里查不到（数据不一致）：先修复 resume_version 绑定，再推进。',
        owner_role: 'RECRUITMENT_OWNER',
        next_action_code: 'LINK_INTAKE_MATERIAL',
      })
    } else if (material.parse_status === 'FAILED') {
      blockers.push({
        code: 'MATERIAL_PARSE_FAILED',
        message: '材料解析失败（parse_status=FAILED）：先修复或重新导入材料，再推进。',
        owner_role: 'RECRUITMENT_OWNER',
        next_action_code: 'REPARSE_MATERIAL',
      })
    }
  }
  if (app.rubric_version_id === null) {
    blockers.push({
      code: 'RUBRIC_NOT_PINNED',
      message: '申请还没有钉住 rubric 版本（rubric_version_id 为空）：先由 recruitment_job_rubric_approve '
        + '批准岗位的一个 rubric 版本（它会把 job.current_rubric_version_id 指过去），再调用本命令 —— '
        + '写路径会在同一事务里补钉后推进；只读视图不写库，所以它只报告这个事实。',
      owner_role: 'JOB_HIRING_MANAGER',
      next_action_code: 'PIN_RUBRIC_VERSION',
    })
  }
  return blockers
}

// =====================================================================
//  F1 · rubric 补钉（T1 前置的一部分；只由写路径调用）
// =====================================================================

/** 岗位当前指针 + 它是否"此刻已批准"（补钉的唯一输入）。 */
interface RubricPinTarget {
  readonly rubric_version_id: string
  readonly version_no: number
  /** 审计事件要记的岗位 id（本函数的申请行不含 `job_id`，从这条 join 里带出来）。 */
  readonly job_id: string
}

/** 一次成功补钉的结果（更新后的 `record_version` 是后续阶段 UPDATE 的乐观并发条件）。 */
interface RubricPinResult {
  readonly rubric_version_id: string
  readonly record_version: number
  readonly event_id: string
}

/**
 * 从 GUC 读执行账号（`SET LOCAL recruitment.actor_id` 由调用方的 `withActor` 设置）。
 *
 * 为什么要读它：补钉会写业务行 + 审计事件，必须留下"谁做的"。没有 actor 就**拒绝写入**
 * （与 `fn_row_guard` 的 `ACTOR_REQUIRED` 同一口径），绝不做匿名写入。
 * @param client - 事务内连接。
 * @returns actor UUID 文本；没有则 `null`。
 */
async function currentActorId(client: DatabaseClient): Promise<string | null> {
  const { rows } = await client.query<{ actor_id: string | null }>(
    "select nullif(current_setting('recruitment.actor_id', true), '') as actor_id",
  )
  return rows[0]?.actor_id ?? null
}

/**
 * 读出"岗位当前指针指向的版本，且该版本此刻已批准"（D-21 / D-48）。
 *
 * 判据逐条对应 `job-rubric-rules.md` §4.2 的 `approved(v, as_of)`：
 * 指针非空 → 版本仍在且属于本岗位 → 有生效的 APPROVED 审批（hash 一致、未被取代、未过期）。
 * **不回退**到"已批准版本里 version_no 最大"（D-48）：指针为空就是没有当前版本。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id（用于取它的岗位指针）。
 * @returns 可钉的目标；没有则 `null`。
 */
async function readPinnableRubric(client: DatabaseClient, tenantId: string, applicationId: string): Promise<RubricPinTarget | null> {
  const { rows } = await client.query<RubricPinTarget>(
    `select rv.id as rubric_version_id, rv.version_no, j.id as job_id
       from recruitment.application a
       join recruitment.job j
         on j.id = a.job_id and j.tenant_id = a.tenant_id
       join recruitment.rubric_version rv
         on rv.id = j.current_rubric_version_id
        and rv.tenant_id = j.tenant_id
        and rv.job_id = j.id
      where a.tenant_id = $1 and a.id = $2
        and j.current_rubric_version_id is not null
        and exists (
          select 1 from recruitment.approval ap
           where ap.tenant_id = rv.tenant_id
             and ap.resource_type = 'RUBRIC_VERSION'
             and ap.resource_id = rv.id
             and ap.status = 'APPROVED'
             and ap.canonical_payload_hash = rv.payload_hash
             and ap.superseded_by_approval_id is null
             and (ap.expires_at is null or ap.expires_at > now())
        )`,
    [tenantId, applicationId],
  )
  return rows[0] ?? null
}

/**
 * 把审计事件落到 `event_inbox`（内部事实，`FALLBACK_KEY` 必须绑 `source_object_id`）。
 * @param client - 事务内连接。
 * @param input - 事件字段。
 * @returns 新事件 id。
 */
async function insertRubricPinnedEvent(
  client: DatabaseClient,
  input: {
    readonly tenantId: string
    readonly applicationId: string
    readonly jobId: string
    readonly rubricVersionId: string
    readonly rubricVersionNo: number
    readonly pinnedBy: string
    readonly recordVersion: number
  },
): Promise<string> {
  const payload = {
    table: 'application',
    column: 'rubric_version_id',
    record_id: input.applicationId,
    application_id: input.applicationId,
    job_id: input.jobId,
    rubric_version_id: input.rubricVersionId,
    rubric_version_no: input.rubricVersionNo,
    from: null,
    to: input.rubricVersionId,
    actor_id: input.pinnedBy,
    application_record_version: input.recordVersion,
    source: 'recruitment.application.stage_advance',
    reason: 'T1 前置：岗位当前已批准的 rubric 版本被补钉到申请上（D-21/D-48，F1）',
  }
  const { rows } = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, provider_event_id, event_type, schema_version,
        occurred_at, received_at, recorded_at, correlation_id, causation_id,
        idempotency_key, idempotency_source, source_object_id,
        payload_ref, payload, trust_level, normalized_event_type, normalizer_version)
     values ($1, 'internal', null, 'application.rubric_version.pinned', 1,
             now(), now(), now(), null, null,
             $2, 'FALLBACK_KEY', $3,
             null, $4::jsonb, 'INTERNAL', 'application.rubric_version.pinned', 'schema/0001')
     returning event_id`,
    [
      input.tenantId,
      `rubric-pin:${randomUUID()}`,
      input.applicationId,
      JSON.stringify(payload),
    ],
  )
  const row = rows[0]
  if (row === undefined) {
    throw stageError('INVARIANT_VIOLATION', 'PIN_AUDIT_EVENT_MISSING', '补钉审计事件没有写入成功，整体回滚。', {
      application_id: input.applicationId,
    })
  }
  return row.event_id
}

/**
 * T1 的 rubric 补钉：把岗位**当前已批准**的 rubric 版本钉到申请上（同一事务内）。
 *
 * 只在"申请的 rubric_version_id 为空"时被调用（调用方已判）。顺序：
 *   1. 读岗位当前指针并当场复核它此刻已批准（**只读**；没有目标就返回 `null`，不要求 actor）；
 *   2. 读 actor（必须已 `SET LOCAL recruitment.actor_id`；没有就拒绝，不做匿名写入）；
 *   3. 条件 UPDATE（`rubric_version_id is null`，经 `fn_row_guard` 自增 `record_version`）；
 *      0 行 ⇒ 并发/冲突，抛 `VERSION_CONFLICT`（本事务已 `select … for update`，正常不可达）；
 *   4. 写审计事件（`application.rubric_version.pinned`）。
 *
 * @param client - 事务内连接（调用方已开事务并设 actor）。
 * @param tenantId - 租户。
 * @param app - 本次读到的申请（带岗位信息）。
 * @returns 补钉结果；"没有可钉的目标"返回 `null`（调用方据此仍报 `RUBRIC_NOT_PINNED`）。
 * @throws RecruitmentToolError - `INVALID_ARGS`（没有 actor）/ `VERSION_CONFLICT`。
 */
async function pinCurrentRubric(
  client: DatabaseClient,
  tenantId: string,
  app: ApplicationRow,
): Promise<RubricPinResult | null> {
  // 先只读确认"真的有一个已批准的当前版本"：没有就返回 null（不写、也不要求 actor）。
  const target = await readPinnableRubric(client, tenantId, app.id)
  if (target === null) return null
  const pinnedBy = await currentActorId(client)
  if (pinnedBy === null) {
    throw stageError(
      'INVALID_ARGS',
      'ACTOR_REQUIRED',
      '执行上下文没有 actor（SET LOCAL recruitment.actor_id），拒绝补钉写入。',
      { application_id: app.id },
    )
  }
  const updated = await client.query<{ record_version: number }>(
    `update recruitment.application
        set rubric_version_id = $3
      where id = $1 and tenant_id = $2 and rubric_version_id is null
      returning record_version`,
    [app.id, tenantId, target.rubric_version_id],
  )
  const row = updated.rows[0]
  if (row === undefined) {
    throw stageError(
      'VERSION_CONFLICT',
      'APPLICATION_RUBRIC_PIN_CONFLICT',
      '补钉 UPDATE 未命中（申请已被并发钉住/改过）：本调用整体回滚，请重读后再决定。',
      { application_id: app.id, rubric_version_id: target.rubric_version_id },
    )
  }
  const eventId = await insertRubricPinnedEvent(client, {
    tenantId,
    applicationId: app.id,
    jobId: target.job_id,
    rubricVersionId: target.rubric_version_id,
    rubricVersionNo: target.version_no,
    pinnedBy,
    recordVersion: row.record_version,
  })
  return { rubric_version_id: target.rubric_version_id, record_version: row.record_version, event_id: eventId }
}

/**
 * 读 current（未被取代）的 SCREENING 决策。`0008` 的 `uq_decision_current` 是
 * (tenant, application, scope, stage_code) 上的可延迟排斥约束 → 同一申请最多一条 current
 * SCREENING；`order by decided_at desc, id` 只是让读数确定，不是"取最新一条覆盖旧条"。
 * 同时带出决策人的显示名（责任人推导用）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 * @returns current 决策；没有则 `null`。
 */
async function readCurrentScreeningDecision(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ScreeningDecisionRow | null> {
  const { rows } = await client.query<ScreeningDecisionRow>(
    `select d.id, d.result, d.decided_by_actor_id,
            a.display_name as decided_by_display_name
       from recruitment.decision d
       left join recruitment.actor a
         on a.id = d.decided_by_actor_id and a.tenant_id = d.tenant_id
      where d.tenant_id = $1
        and d.application_id = $2
        and d.decision_scope = 'SCREENING'
        and d.superseded_by_decision_id is null
      order by d.decided_at desc, d.id
      limit 1`,
    [tenantId, applicationId],
  )
  return rows[0] ?? null
}

// =====================================================================
//  责任与下一步（结构化；v1.1）
// =====================================================================

/** 原始阻塞（责任角色/下一步已定；actor 由 {@link enrichBlockers} 统一补）。 */
interface RawBlocker {
  readonly code: StageBlockerCode
  readonly message: string
  readonly owner_role: StageOwnerRole
  readonly next_action_code: StageNextActionCode
  /** 已经知道的责任人（例如 SCREENING 决策人）；给了就不再走招聘负责人推导。 */
  readonly explicit_owner?: ResolvedOwner
}

/** 原始告警（同 blocker，只是 kind 不同）。 */
interface RawWarning {
  readonly code: StageWarningCode
  readonly message: string
  readonly owner_role: StageOwnerRole
  readonly next_action_code: StageNextActionCode
  readonly explicit_owner?: ResolvedOwner
}

/** 把 actor 字段拼进结构化责任里（推不出来就省略键 —— 契约禁止 null）。 */
function responsibilityOf(
  owner_role: StageOwnerRole,
  next_action_code: StageNextActionCode,
  owner: ResolvedOwner | undefined,
): StageResponsibility {
  const actorId = owner?.actor_id
  const displayName = owner?.display_name
  return {
    owner_role,
    next_action_code,
    ...(actorId === undefined || actorId === '' ? {} : { owner_actor_id: actorId }),
    ...(displayName === undefined || displayName === '' ? {} : { owner_display_name: displayName }),
  }
}

/**
 * 给原始阻塞/告警补"责任人"：
 *   * 有 `explicit_owner`（SCREENING 决策人）→ 直接用，不再查库；
 *   * 否则只查一次招聘负责人（job → department.hiring_manager_actor_id）并套给所有条目；
 *   * 查不到 → 只保留 `owner_role` + `next_action_code`（仍然机检得动）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 * @param rawBlockers - 原始阻塞。
 * @param rawWarnings - 原始告警。
 * @returns 结构化的 blockers / warnings。
 */
async function enrichObstructions(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  rawBlockers: readonly RawBlocker[],
  rawWarnings: readonly RawWarning[],
): Promise<{ blockers: StageBlocker[]; warnings: StageWarning[] }> {
  const all: readonly (RawBlocker | RawWarning)[] = [...rawBlockers, ...rawWarnings]
  const needsResolvedOwner = all.some((item) => item.explicit_owner === undefined)
  const resolved = needsResolvedOwner
    ? await resolveRecruitmentOwner(client, tenantId, applicationId)
    : undefined

  const blockers = rawBlockers.map((item): StageBlocker => ({
    code: item.code,
    message: item.message,
    ...responsibilityOf(item.owner_role, item.next_action_code, item.explicit_owner ?? resolved),
  }))
  const warnings = rawWarnings.map((item): StageWarning => ({
    code: item.code,
    message: item.message,
    ...responsibilityOf(item.owner_role, item.next_action_code, item.explicit_owner ?? resolved),
  }))
  return { blockers, warnings }
}

// =====================================================================
//  逐边判定（事实 → PASS / WAIT / BLOCKED）
// =====================================================================

/**
 * 一条梯子边的判定结局。
 *   * `PASS` 事实成立，可以走这条边；`pinned` 非空表示这一跳**顺手补钉了 rubric**
 *     （写路径专有；调用方必须用它的 `record_version` 作为后续阶段 UPDATE 的并发条件）；
 *   * `WAIT` 事实还没发生（等人），既不是推进也不是错误；
 *   * `BLOCKED` 事实明确反对（带可执行提示）。
 */
type EdgeOutcome =
  | { readonly kind: 'PASS'; readonly pinned?: RubricPinResult }
  | { readonly kind: 'WAIT' }
  | { readonly kind: 'BLOCKED'; readonly blockers: readonly RawBlocker[] }

/**
 * T1（`from=S6`）的判定：材料 + rubric 齐 → PASS；缺任何一条 → BLOCKED。
 *
 * 唯一的写入可能：**T1 只差 rubric 这一条**、且 `allowPin=true` 时，先补钉再判 PASS
 * （见文件头 F1）。补钉失败 / 没有可钉的已批准版本 → 仍按原 blocker 返回 BLOCKED（零阶段写入）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param app - 读到的申请。
 * @param allowPin - 写路径 true（可补钉）/ 只读视图 false（一条写语句都不发）。
 * @returns 三分法结局（T1 没有 WAIT 分支）。
 */
async function evaluateT1(
  client: DatabaseClient,
  tenantId: string,
  app: ApplicationRow,
  allowPin: boolean,
): Promise<EdgeOutcome> {
  const found = await checkS6ToS7(client, tenantId, app)
  if (found.length === 0) return { kind: 'PASS' }
  // 只在"唯一缺口就是这个 rubric"时补钉：还有材料问题就一行都不写（BLOCKED 必须零写入）。
  if (allowPin && found.length === 1 && found[0]?.code === 'RUBRIC_NOT_PINNED') {
    const pinned = await pinCurrentRubric(client, tenantId, app)
    if (pinned !== null) return { kind: 'PASS', pinned }
  }
  return { kind: 'BLOCKED', blockers: found }
}

/**
 * T2（`from=S7`）的判定：current SCREENING 决策 ADVANCE → PASS；
 * 还没有决策 → WAIT；HOLD / REJECT / WITHDRAW → BLOCKED（责任人=做这个决定的人）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 * @returns 三分法结局。
 */
async function evaluateT2(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<EdgeOutcome> {
  const decision = await readCurrentScreeningDecision(client, tenantId, applicationId)
  if (decision === null) return { kind: 'WAIT' }
  if (decision.result === 'ADVANCE') return { kind: 'PASS' }
  // HOLD / REJECT / WITHDRAW 是**已发生的反向事实**：不推进，阶段留在 S7。
  // 责任人 = 真的做过这个决定的人（decision.decided_by_actor_id，库里可查），不是执行账号。
  const explicitOwner: ResolvedOwner = {
    actor_id: decision.decided_by_actor_id,
    ...(decision.decided_by_display_name === null ? {} : { display_name: decision.decided_by_display_name }),
  }
  return {
    kind: 'BLOCKED',
    blockers: [{
      code: 'SCREENING_DECISION_NOT_ADVANCE',
      message: `current SCREENING 决策（${decision.id}）的 result=${decision.result}：本命令不推进，阶段留在 S7。`
        + '要改变结论，先由人做一次新的决策（recruitment_decision_record），再重试。',
      owner_role: 'SCREENING_DECIDER',
      next_action_code: 'SUPERSEDE_SCREENING_DECISION',
      explicit_owner: explicitOwner,
    }],
  }
}

// =====================================================================
//  统一诊断（写路径与只读视图共用同一套判定）
// =====================================================================

/** 诊断结果（`false` 时**不含写入**；`app` 是补钉之后的真实行）。 */
interface StageDiagnosis {
  readonly app: ApplicationRow
  readonly status: StageAdvanceStatus
  /** 需要走的边（按顺序；可能 0 条）。 */
  readonly transitions: readonly StageEdge[]
  readonly blockers: readonly StageBlocker[]
  readonly warnings: readonly StageWarning[]
  /** 还在等的事实（工作台据此给"下一步"）。 */
  readonly pending_fact?: 'SCREENING_DECISION'
}

/**
 * 判定"这条申请现在能走到哪/被什么挡住"。
 *
 * `allowPin=false` 时**只读**（工作台视图）；`allowPin=true`（写路径）时，T1 允许在
 * "只差 rubric 这一条"的情况下先补钉（见文件头 F1）。除补钉外本函数不写任何东西。
 *
 * 顺序：
 *   0) 目录完整性（S6/S7/S8 必须在 stage_catalog 里）；
 *   1) 非 ACTIVE → BLOCKED(APPLICATION_NOT_ACTIVE)；
 *   2) 指针超前（> S8）→ NO_OP + STAGE_AHEAD 警告（一条 UPDATE 都不发）；
 *   3) 指针在梯子起点之前（< S6）→ BLOCKED(STAGE_NOT_ON_LADDER)；
 *   4) 从当前阶段往后逐边走：PASS 记一条边，WAIT/BLOCKED 停下。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 * @param lock - 写路径 true（行锁）/ 只读视图 false。
 * @param allowPin - 是否允许 T1 补钉 rubric（写路径 true / 只读视图 false）。
 * @returns 诊断结果（阻断原因已带责任与下一步；`app` 是补钉之后的真实值）。
 */
async function diagnose(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  lock: boolean,
  allowPin: boolean,
): Promise<StageDiagnosis> {
  let app = await readApplication(client, tenantId, applicationId, lock)

  // ---- 顺序：先看"这条申请该不该被本命令碰"，再看梯子 ----
  const catalog = await readStageCatalog(client, tenantId, [
    app.current_stage_code,
    LADDER_START,
    LADDER_TERMINAL,
  ])
  const current = catalog.get(app.current_stage_code)
  const start = catalog.get(LADDER_START)
  const terminal = catalog.get(LADDER_TERMINAL)
  if (current === undefined || start === undefined || terminal === undefined) {
    // FK 保证 current_stage_code 在目录里；梯子两端不齐 = 该租户目录残缺（不是本命令能修的）。
    throw stageError(
      'INVARIANT_VIOLATION',
      'STAGE_CATALOG_INCOMPLETE',
      '该租户的 stage_catalog 缺少本命令需要的阶段码（S6 / S7 / S8），无法判断阶段顺序。',
      { application_id: applicationId, stage_code: app.current_stage_code },
    )
  }

  // 0) 申请不在推进范围：非 ACTIVE 的申请不推进（0009 的申请周期语义；不写任何东西）。
  if (app.lifecycle_status !== 'ACTIVE') {
    return finishWithObstructions(client, tenantId, applicationId, app, [{
      code: 'APPLICATION_NOT_ACTIVE',
      message: `申请的 lifecycle_status=${app.lifecycle_status}，不在推进范围（只推进 ACTIVE 的申请）。`,
      owner_role: 'RECRUITMENT_OWNER',
      next_action_code: 'REOPEN_APPLICATION',
    }], [])
  }

  // 1) 指针已超前于本命令能推导的事实（本命令最多推到 S8）：一条 UPDATE 都不发。
  if (current.sort_order > terminal.sort_order) {
    return finishWithObstructions(client, tenantId, applicationId, app, [], [{
      code: 'STAGE_AHEAD',
      message: `当前阶段 ${app.current_stage_code} 已经超过本命令能推导的事实（最多到 ${LADDER_TERMINAL}）：`
        + '不倒退、不跳阶，一条 UPDATE 都不发。后续阶段由面试 / 评价线自己的事实推进。',
      owner_role: 'RECRUITMENT_OWNER',
      next_action_code: 'VERIFY_STAGE_PROGRESSION',
    }])
  }

  // 2) 指针在梯子起点之前：本命令只覆盖 S6→S7→S8，不从别的阶段插队。
  if (current.sort_order < start.sort_order) {
    return finishWithObstructions(client, tenantId, applicationId, app, [{
      code: 'STAGE_NOT_ON_LADDER',
      message: `当前阶段 ${app.current_stage_code} 不在本命令的迁移梯子上（只覆盖 `
        + `${LADDER_START}→S7→${LADDER_TERMINAL}）：请先用上游工具把它带到 ${LADDER_START}。`,
      owner_role: 'RECRUITMENT_OWNER',
      next_action_code: 'START_AT_INTAKE',
    }], [])
  }

  // ---- 从当前阶段往后走梯子：每一步都必须有事实；反向事实立刻 STOP ----
  //
  // 每条边有三种结局：
  //   PASS    事实成立 → 记一条边，指针前移一格再试下一条边；
  //   WAIT    事实还没发生（例如还没有人的 SCREENING 结论）→ 停下，不算错误；
  //   BLOCKED 事实明确反对（HOLD/REJECT、材料解析失败、rubric 未钉）→ 停下并报 blockers。
  // 这个三分法是幂等性的来源：第二次调用在"已到的事实位置"上得到 WAIT → NO_OP，零 UPDATE。
  const applied: StageEdge[] = []
  const rawBlockers: RawBlocker[] = []
  let pendingFact: 'SCREENING_DECISION' | undefined
  let cursor = app.current_stage_code
  while (applied.length <= LADDER.length) {
    const step = LADDER.find((edge) => edge.from === cursor)
    if (step === undefined) break
    const outcome = step.rule === 'T1'
      ? await evaluateT1(client, tenantId, app, allowPin)
      : await evaluateT2(client, tenantId, applicationId)
    if (outcome.kind === 'BLOCKED') {
      rawBlockers.push(...outcome.blockers)
      break
    }
    if (outcome.kind === 'WAIT') {
      if (step.rule === 'T2') pendingFact = 'SCREENING_DECISION'
      break
    }
    // F1：这一跳补钉了 rubric —— 把申请对象换成写后的事实，后续阶段 UPDATE 必须用新
    // `record_version`（补钉那条 UPDATE 已经让 `fn_row_guard` 自增过一次）。
    if (outcome.pinned !== undefined) {
      app = { ...app, rubric_version_id: outcome.pinned.rubric_version_id, record_version: outcome.pinned.record_version }
    }
    applied.push(step)
    cursor = step.to
  }

  if (applied.length === 0) {
    return finishWithObstructions(client, tenantId, applicationId, app, rawBlockers, [], pendingFact)
  }
  // 有需要走的边：先把"停在下一跳的原因"也结构化（例如 S6 满足 T1、但 SCREENING=HOLD）。
  const enriched = await enrichObstructions(client, tenantId, applicationId, rawBlockers, [])
  return {
    app,
    status: 'ADVANCED',
    transitions: applied,
    blockers: enriched.blockers,
    warnings: enriched.warnings,
    ...(pendingFact === undefined ? {} : { pending_fact: pendingFact }),
  }
}

/**
 * 造一个"没有需要走的边"的诊断：把原始阻塞（和告警）结构化成 blockers/warnings，
 * 再定三态（有 blocker → BLOCKED；否则 NO_OP）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 * @param app - 读到的申请。
 * @param rawBlockers - 原始阻塞。
 * @param rawWarnings - 原始告警。
 * @param pendingFact - 还在等的事实（可选）。
 * @returns 诊断结果。
 */
async function finishWithObstructions(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  app: ApplicationRow,
  rawBlockers: readonly RawBlocker[],
  rawWarnings: readonly RawWarning[],
  pendingFact?: 'SCREENING_DECISION',
): Promise<StageDiagnosis> {
  const enriched = await enrichObstructions(client, tenantId, applicationId, rawBlockers, rawWarnings)
  return {
    app,
    status: enriched.blockers.length > 0 ? 'BLOCKED' : 'NO_OP',
    transitions: [],
    blockers: enriched.blockers,
    warnings: enriched.warnings,
    ...(pendingFact === undefined ? {} : { pending_fact: pendingFact }),
  }
}

// =====================================================================
//  写路径
// =====================================================================

/**
 * 发一条**带版本条件**的阶段 UPDATE。
 *
 * 不写 `record_version` / `stage_changed_at` / `stage_source_event_id` / `updated_at`：
 * 它们全部由 `fn_row_guard` 维护（手写=重复自增 + 审计篡改）。
 * `stage_entered_at` 必须显式写（见文件头第 2 条）；用 `greatest(... + 1µs)` 保证严格单调。
 * 右边的 `stage_entered_at` / `created_at` 都是 **UPDATE 前的行值**（SQL 语义）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param applicationId - 申请 id。
 * @param edge - 本次要走的那条边。
 * @param expectedRecordVersion - 本次 UPDATE 认可的版本（上一次 RETURNING 的真实值）。
 * @returns 新行；0 行 → `null`（调用方转 `VERSION_CONFLICT`）。
 */
async function applyEdge(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  edge: StageEdge,
  expectedRecordVersion: number,
): Promise<UpdatedApplicationRow | null> {
  const { rows } = await client.query<UpdatedApplicationRow>(
    `update recruitment.application
        set current_stage_code = $4,
            stage_entered_at = greatest(
              clock_timestamp(),
              stage_entered_at + interval '1 microsecond',
              created_at + interval '1 microsecond'
            )
      where id = $1
        and tenant_id = $2
        and current_stage_code = $3
        and record_version = $5
      returning current_stage_code, record_version,
                (extract(epoch from stage_entered_at) * 1000000)::double precision as stage_entered_at_us`,
    [applicationId, tenantId, edge.from, edge.to, expectedRecordVersion],
  )
  return rows[0] ?? null
}

/**
 * 派生式推进：把"已经发生的事实"翻译成阶段指针前移。
 *
 * 调用方必须在事务里（`withActor`），本函数**不**自己 begin/commit：
 * 多跳要么全成、要么全不成（任一跳抛错 → 调用方回滚）。
 *
 * 本函数可能写两类行，都只在事实已经成立时：① T1 的 rubric 补钉（F1：`application.rubric_version_id`
 * + 一条内部审计事件）；② 阶段迁移（一条边一条 UPDATE，由 `fn_row_guard` 维护审计列）。
 * 被 BLOCKED / NO_OP 时不补钉也不迁移（零 UPDATE，幂等的前提）。
 * @param client - 事务内连接（actor 已 `SET LOCAL`）。
 * @param input - `{tenantId, applicationId}`（没有目标阶段、没有 actor）。
 * @returns 三态结论 + 真实发生的迁移。
 * @throws RecruitmentToolError - `NOT_FOUND` / `VERSION_CONFLICT` / `INVARIANT_VIOLATION`
 *   / `INVALID_ARGS`（补钉需要 actor 但没有）。
 */
export async function advanceApplicationStage(
  client: DatabaseClient,
  input: AdvanceApplicationStageInput,
): Promise<StageAdvanceResult> {
  const { tenantId, applicationId } = input
  try {
    const diagnosis = await diagnose(client, tenantId, applicationId, true, true)
    const app = diagnosis.app

    if (diagnosis.transitions.length === 0) {
      // 没有需要走的边：零 UPDATE（幂等 / BLOCKED / STAGE_AHEAD 都不写库）。
      return {
        application_id: app.id,
        stage_code: app.current_stage_code,
        record_version: app.record_version,
        status: diagnosis.status,
        transitions: [],
        blockers: diagnosis.blockers,
        warnings: diagnosis.warnings,
      }
    }

    // ---- 落库：一条边一条 UPDATE，每条都带 record_version ----
    let expectedRecordVersion = app.record_version
    let previousStageEnteredAtUs = app.stage_entered_at_us
    let lastStageCode = app.current_stage_code
    let lastRecordVersion = app.record_version

    for (const edge of diagnosis.transitions) {
      const updated = await applyEdge(client, tenantId, applicationId, edge, expectedRecordVersion)
      if (updated === null) {
        // 0 行：行锁之外还有别人改过（或这里被别的写路径绕过锁）→ 版本冲突，整体回滚。
        throw stageError(
          'VERSION_CONFLICT',
          'APPLICATION_RECORD_VERSION_MISMATCH',
          '更新 0 行：申请的 current_stage_code / record_version 与本次读到的值不一致（并发修改）。',
          {
            application_id: applicationId,
            expected_stage_code: edge.from,
            target_stage_code: edge.to,
            expected_record_version: expectedRecordVersion,
          },
        )
      }
      // 写后断言 1：`stage_entered_at` 真的前进了（本仓既有缺陷的兜底，见文件头第 2 条）。
      // 用**微秒**比较，不用 JS Date（Date 只有毫秒精度，两跳差 1µs 时会被判成相等）。
      if (!(updated.stage_entered_at_us > app.created_at_us)) {
        throw stageError(
          'INVARIANT_VIOLATION',
          'STAGE_ENTERED_AT_NOT_ADVANCED',
          'stage_entered_at 没有前进到 created_at 之后：stage_entered_at 写入失败（本仓既有缺陷回归）。',
          { application_id: applicationId, stage_code: updated.current_stage_code },
        )
      }
      // 写后断言 2：相对**上一跳**也必须前进（多跳时两跳不能落到同一时刻）。
      if (!(updated.stage_entered_at_us > previousStageEnteredAtUs)) {
        throw stageError(
          'INVARIANT_VIOLATION',
          'STAGE_ENTERED_AT_NOT_MONOTONIC',
          'stage_entered_at 没有相对上一跳前进（多跳的时间戳必须单调递增）。',
          { application_id: applicationId, stage_code: updated.current_stage_code },
        )
      }
      // 写后断言 3：库里的阶段码必须就是我们要求的那一格（触发器/并发都不会改它）。
      if (updated.current_stage_code !== edge.to) {
        throw stageError(
          'INVARIANT_VIOLATION',
          'STAGE_CODE_MISMATCH',
          'UPDATE 之后读回的阶段码与目标不一致。',
          { application_id: applicationId, expected_stage_code: edge.to, actual_stage_code: updated.current_stage_code },
        )
      }
      expectedRecordVersion = updated.record_version
      previousStageEnteredAtUs = updated.stage_entered_at_us
      lastStageCode = updated.current_stage_code
      lastRecordVersion = updated.record_version
    }

    // 已经推进了至少一跳 → ADVANCED。`blockers` 仅在"推进到下一跳时遇到反向事实"时非空
    // （例如 S6 满足 T1、但 current SCREENING=HOLD：先如实推到 S7，再停在 S7）。
    return {
      application_id: applicationId,
      stage_code: lastStageCode,
      record_version: lastRecordVersion,
      status: 'ADVANCED',
      transitions: diagnosis.transitions.map((edge) => ({ from: edge.from, to: edge.to })),
      blockers: diagnosis.blockers,
      warnings: diagnosis.warnings,
    }
  } catch (error) {
    if (isConcurrentUpdateError(error)) {
      throw stageError(
        'VERSION_CONFLICT',
        'APPLICATION_CONCURRENT_UPDATE',
        '并发修改：另一个事务先改了这条申请。本调用已整体回滚，请重读后再决定。',
        { application_id: applicationId },
      )
    }
    throw error
  }
}

// =====================================================================
//  只读视图（工作台直接用；不加锁、不写库）
// =====================================================================

/**
 * 只读的「阻塞视图」：给工作台渲染「当前状态、阻塞原因、责任人、下一步」。
 *
 * **只读**：判定走 `diagnose(lock=false, allowPin=false)`（普通 `select`、不补钉），因此可以安全地跑在
 * `withReadOnly` 事务里；本函数**不发任何 UPDATE/INSERT**，也不需要 actor。
 *
 * 整条申请级别的 `owner` / `next_action` 取"优先级最高的一条"：
 * blockers（按判定顺序）优先，其次 warnings；都没有时给一个通用下一步
 * （事实已齐 → `ADVANCE_STAGE`；在等人 → `RECORD_SCREENING_DECISION`；否则 `CONTINUE_DOWNSTREAM`）。
 * @param client - 连接（可以来自只读事务）。
 * @param input - `{tenantId, applicationId}`。
 * @returns 工作台视图（`stage`/`blockers`/`owner`/`next_action` 恒有）。
 * @throws RecruitmentToolError - `NOT_FOUND` / `INVARIANT_VIOLATION`。
 */
export async function readStageBlockedView(
  client: DatabaseClient,
  input: AdvanceApplicationStageInput,
): Promise<StageBlockedView> {
  const { tenantId, applicationId } = input
  let diagnosis: StageDiagnosis
  try {
    diagnosis = await diagnose(client, tenantId, applicationId, false, false)
  } catch (error) {
    if (isConcurrentUpdateError(error)) {
      throw stageError(
        'VERSION_CONFLICT',
        'APPLICATION_CONCURRENT_UPDATE',
        '并发修改：重读一次即可。',
        { application_id: applicationId },
      )
    }
    throw error
  }

  const obstructions: StageObstruction[] = [
    ...diagnosis.blockers.map((item): StageObstruction => ({ kind: 'BLOCKER', ...item })),
    ...diagnosis.warnings.map((item): StageObstruction => ({ kind: 'WARNING', ...item })),
  ]

  // 阶段名：目录里查；诊断已经读过目录（这里为视图单独再读一次，保持函数自洽）。
  const catalog = await readStageCatalog(client, tenantId, [diagnosis.app.current_stage_code])
  const stageName = catalog.get(diagnosis.app.current_stage_code)?.name ?? diagnosis.app.current_stage_code

  let owner: StageOwner
  let nextAction: StageNextAction
  const primary = obstructions[0]
  if (primary !== undefined) {
    owner = {
      role: primary.owner_role,
      ...(primary.owner_actor_id === undefined ? {} : { actor_id: primary.owner_actor_id }),
      ...(primary.owner_display_name === undefined ? {} : { display_name: primary.owner_display_name }),
    }
    nextAction = {
      code: primary.next_action_code,
      message: NEXT_ACTION_MESSAGES[primary.next_action_code],
      owner_role: primary.owner_role,
      ...(primary.owner_actor_id === undefined ? {} : { owner_actor_id: primary.owner_actor_id }),
    }
  } else {
    // 没有阻塞也没有告警：给"下一步"（谁来做仍然由招聘负责人兜底）。
    const resolved = await resolveRecruitmentOwner(client, tenantId, applicationId)
    const code: StageNextActionCode = diagnosis.status === 'ADVANCED'
      ? 'ADVANCE_STAGE'
      : diagnosis.pending_fact === 'SCREENING_DECISION'
        ? 'RECORD_SCREENING_DECISION'
        : 'CONTINUE_DOWNSTREAM'
    owner = {
      role: 'RECRUITMENT_OWNER',
      ...(resolved.actor_id === undefined ? {} : { actor_id: resolved.actor_id }),
      ...(resolved.display_name === undefined ? {} : { display_name: resolved.display_name }),
    }
    nextAction = {
      code,
      message: NEXT_ACTION_MESSAGES[code],
      owner_role: 'RECRUITMENT_OWNER',
      ...(resolved.actor_id === undefined ? {} : { owner_actor_id: resolved.actor_id }),
    }
  }

  return {
    application_id: diagnosis.app.id,
    stage: diagnosis.app.current_stage_code,
    stage_name: stageName,
    lifecycle_status: diagnosis.app.lifecycle_status,
    record_version: diagnosis.app.record_version,
    status: diagnosis.status,
    blocked: diagnosis.status === 'BLOCKED',
    blockers: obstructions,
    owner,
    next_action: nextAction,
  }
}
