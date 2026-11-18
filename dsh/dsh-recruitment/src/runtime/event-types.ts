// 事件类型的**唯一权威注册表**（Single Source of Truth）。
//
// 为什么必须有这个文件（真实缺陷，2026-11-14）：
//   工具发射的事件名与 `routing.ts` 手抄的路由表**对不上**——
//   工具发 `resume.intake.received` / `scorecard.submit` / `decision.record`，
//   路由表只认 `resume_received` / `scorecard_submitted` / `transcript_ready` 这些
//   **没有任何发射方**的旧名字。结果是 40 条真实事件全落到语义 Gate 被
//   `SEMANTIC_GATE_REJECTED` 拒掉，"事件自动触发"整条链是断的，而单测因为手工构造
//   事件名一直是绿的（R2 假接线）。
//
// 修法不是"给路由表补几个别名"，而是把**"谁发什么"**变成一份可机检的数据：
//   * 发射方（`src/tools/**` / `src/domain/**`）引用本文件的 `EVENT_TYPES` 常量，
//     不再各写一份字符串；
//   * 路由方（`src/runtime/routing.ts`）从本文件的 `EVENT_TYPE_REGISTRY` **派生**
//     确定性路由表与显式忽略表，不再手抄；
//   * `test/runtime/event-types.test.ts` 扫描 `src/**` 的所有发射点，断言每个发射名
//     都已登记（发射未登记的名字 → 测试红）；同时反向断言登记项的生产者文件确实
//     引用了本文件（登记一个没人发的名字也会红）。
//
// 三条纪律：
//   1. **登记即裁决**：每个真实事件类型必须显式属于 `DETERMINISTIC`（要建任务）或
//      `IGNORED`（明确不建任务，且写明原因）。"表里没有所以落到语义 Gate" 是不可审计
//      的隐式行为，不允许作为已知类型的归宿。
//   2. **未登记 ≠ 已裁决**：未登记的事件仍然走 `DefaultSemanticGate`（这条准入规则
//      一个字都没放宽），但那是给"外部未知信号"用的，不是给已知内部事件用的。
//   3. **名字只写一次**：规范名只在本文件的 `EVENT_TYPES` / `ROW_GUARD_TRIGGERS`
//      里出现；其它地方一律引用常量。
import type { BusinessObjectType } from './types.ts'

/**
 * 事件路由结论（三值取二，没有"未决定"）。
 *
 * `DETERMINISTIC` = 确定性事件路径：按事件类型 + 业务对象建/唤醒 Business Task，
 * 不需要模型先判断"要不要接单"；`IGNORED` = 明确不建任务（必须写原因，落
 * `event_inbox.route_error`，可审计）。
 */
export type EventRouteKind = 'DETERMINISTIC' | 'IGNORED'

/** 事件产生者类别（决定怎么机检它确实存在）。 */
export type EventProducerKind =
  /** 工具（`src/tools/**`）：发射点必须引用本文件的常量。 */
  | 'TOOL'
  /** 领域写路径（`src/domain/**`）：当前 lane 不改它，但名字必须登记并被机检。 */
  | 'DOMAIN_WRITER'
  /** HTTP Host Remote Action（`src/http/**`）：人在浏览器触发的写入口，事件名必须登记。 */
  | 'HTTP_ACTION'
  /** 库触发器（`db/migrations/0001_init.sql` 的 `fn_row_guard`）：名字由表名+列名派生。 */
  | 'DB_TRIGGER'

/** 一个事件类型的产生者：哪个工具/函数/触发器。 */
export interface EventProducer {
  readonly kind: EventProducerKind
  /**
   * 产生者所在文件。
   *
   * 路径基准**随 kind 变化**（机检测试按此解析，不要混用）：
   *   * `TOOL` / `DOMAIN_WRITER` → **包根**相对（`src/tools/...`，即 `dsh/dsh-recruitment` 下）；
   *   * `DB_TRIGGER` → **仓库根**相对（`db/migrations/0001_init.sql`，该文件不在包里）。
   */
  readonly file: string
  /** 人类可读：具体函数 / 触发器。 */
  readonly detail: string
}

/**
 * 确定性的事件路径需要定位的业务对象。
 *
 * `fields` 是 payload 里承载该对象 id 的候选字段（按序尝试）；`byEventRow` 表示
 * payload 里**没有**对象 id 时，可以按事件行自身的事实反查（当前只有一种：材料到达
 * 事件 → `intake_record.event_id`）。
 */
export interface DeterministicObject {
  readonly type: BusinessObjectType
  readonly fields: readonly string[]
  readonly byEventRow: 'INTAKE_RECORD' | null
}

/**
 * 任务优先级档位（1..5，数字越小越先被认领；认领排序见 `store/claim.ts`：
 * `order by priority, next_run_at nulls first, created_at`）。
 *
 * E6-1「人的即时操作与后台批量有优先级区分」的口径：
 *   * **1 = 人在等**：由人在页面上触发的动作所派生的任务，必须能被先认领。
 *     例：`scorecard.submit → EVALUATION_SYNTHESIZE`（面试官提交面评后人在等汇总）。
 *   * **2 = 保留档**（本版未用，留给人正在盯但可稍等的派生任务）。
 *   * **3 = 常规后台**：后台摄取/批处理派生的任务，没人当场等结果。
 *     例：`resume.intake.received → RESUME_PARSE`（材料到达后解析）。
 *   * **4 = 批量**：同一来源短时间大量到达时可降级（含语义准入的 ROUTER_TRIAGE）。
 *     v1.0 只留档位定义，不实现"批量判定"——那是后续版本的范围。
 *   * **5 = 最低档**（本版未用）。
 *
 * 这个常量只作**档位定义/档位说明**，不改变任何行为；行为由各登记项的
 * `routing.priority` 决定。改这里不改登记项的 priority 不会改变认领顺序。
 */
export const PRIORITY_BANDS = {
  /** 人在等：页面动作派生，先认领。 */
  HUMAN_WAITING: 1,
  /** 保留档。 */
  RESERVED: 2,
  /** 常规后台：没人当场等。 */
  BACKGROUND: 3,
  /** 批量：短时间大量到达时降级（v1.0 只定义，不判定）。 */
  BATCH: 4,
  /** 最低档。 */
  LOWEST: 5,
} as const

/** 路由结论 + （确定性时）任务模板。 */
export type EventRouting =
  | {
      readonly kind: 'DETERMINISTIC'
      readonly taskType: string
      readonly title: string
      readonly priority: 1 | 2 | 3 | 4 | 5
      readonly object: DeterministicObject
    }
  | { readonly kind: 'IGNORED'; readonly reason: string }

/** 注册表里的一行。 */
export interface EventTypeDefinition {
  /** 规范名（写进 `event_inbox.event_type` 的逐字字面量）。 */
  readonly type: string
  /**
   * `EVENT_TYPES` 里的常量键（库触发器派生的事件为 `null`）。
   *
   * 存在的唯一理由：让机检测试能断言"生产者文件确实引用的是 `EVENT_TYPES.<键>`"
   * ——即发射方没有另写一个字面量。恒等式 `EVENT_TYPES[constKey] === type` 由测试守住。
   */
  readonly constKey: keyof typeof EVENT_TYPES | null
  readonly producer: EventProducer
  /**
   * 写库时的 `normalizer_version`（`null` = 该插入点没写这一列）。
   *
   * 这个值不是装饰：`RuntimeStore.listPendingEvents` 用
   * `normalizer_version is distinct from 'schema/0001'` 把库触发器的状态审计事件排除
   * 在待路由队列之外。机检测试要求"`schema/0001` 的事件必须是 IGNORED"，
   * 避免出现"登记成确定性、却永远不会被路由"的假登记。
   */
  readonly normalizerVersion: string | null
  readonly routing: EventRouting
}

/**
 * 规范事件名。**发射方与路由方都只引用这里**。
 *
 * 命名约定：`<业务对象>.<动作>`（小写 + 点分），与库触发器
 * `<表>.<列>.changed` 的形态一致，便于按前缀检索。
 */
export const EVENT_TYPES = {
  /** S6 材料到达：`recruitment_application_intake` 写的第一条内部事件。 */
  RESUME_INTAKE_RECEIVED: 'resume.intake.received',
  /** S10 面评提交：`recruitment_scorecard_submit` 写的内部事件。 */
  SCORECARD_SUBMIT: 'scorecard.submit',
  /** 人工决策落库：`recruitment_decision_record` 写的审计事件。 */
  DECISION_RECORD: 'decision.record',
  /** 面试改期：`recruitment_interview_schedule`（RESCHEDULE）的审计事件。 */
  INTERVIEW_RESCHEDULED: 'interview.rescheduled',
  /** 面试取消：`recruitment_interview_schedule`（CANCEL）的审计事件。 */
  INTERVIEW_CANCELLED: 'interview.cancelled',
  /** 面试官撤换：`recruitment_interview_schedule`（WITHDRAW_INTERVIEWER）的审计事件。 */
  INTERVIEWER_WITHDRAWN: 'interviewer.withdrawn',
  /** 岗位 rubric 版本批准：`recruitment_job_rubric_approve` 的审计事件。 */
  JOB_RUBRIC_VERSION_APPROVED: 'job.rubric_version.approved',
  /** 人工核验面试记录（NEEDS_REVIEW/UNVERIFIED → READY/VERIFIED）：`recruitment_interview_record_verify` 的审计事件。 */
  INTERVIEW_RECORD_VERIFIED: 'interview.record.verified',
  /** 阶段推进时把 rubric 版本钉到申请上：`src/domain/stage-advance.ts` 的审计事件。 */
  APPLICATION_RUBRIC_VERSION_PINNED: 'application.rubric_version.pinned',
  /** 岗位关闭：`src/http/actions-job.ts` 在终止事务里写的审计事件。 */
  JOB_CLOSED: 'job.closed',
  /** 逐条 rubric 标准人工纠偏落库：`src/tools/criterion-override.ts` 写的审计事件。 */
  CRITERION_OVERRIDE_RECORDED: 'criterion.override.recorded',
} as const

/** `EVENT_TYPES` 的取值联合（发射方签名用）。 */
export type EventTypeName = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]

/**
 * 库触发器 `fn_row_guard(...)` 的挂载点（逐字对应
 * `db/migrations/0001_init.sql` §9.2 的 `values (...)` 列表）。
 *
 * 触发器写的事件名是派生的：`<table>.<column>.changed`，`normalizer_version='schema/0001'`。
 * 机检测试会解析 0001 的那段 `values` 与本表逐项比对——迁移里加了新触发器却没登记，
 * 测试会红。
 */
export const ROW_GUARD_TRIGGERS = [
  { table: 'requisition', column: 'status' },
  { table: 'job', column: 'status' },
  { table: 'job_posting', column: 'status' },
  { table: 'intake_record', column: 'status' },
  { table: 'application', column: 'lifecycle_status' },
  { table: 'application', column: 'current_stage_code' },
  { table: 'interview', column: 'status' },
  { table: 'transcript_artifact', column: 'transcript_status' },
  { table: 'interview_record', column: 'status' },
  { table: 'scorecard', column: 'status' },
  { table: 'approval', column: 'status' },
  { table: 'business_task', column: 'status' },
  { table: 'task_attempt', column: 'status' },
  { table: 'agent_session', column: 'status' },
  { table: 'durable_effect', column: 'status' },
  { table: 'actor', column: 'status' },
  { table: 'chat_thread', column: 'status' },
  { table: 'transcript_processing_run', column: 'status' },
  { table: 'ai_summary', column: 'status' },
] as const

/** `fn_row_guard` 派生的事件名：`<table>.<column>.changed`。 */
export function rowGuardEventType(trigger: { readonly table: string; readonly column: string }): string {
  return `${trigger.table}.${trigger.column}.changed`
}

/** 库触发器写的全部事件名（19 个挂载点）。 */
export const ROW_GUARD_EVENT_TYPES: readonly string[] = ROW_GUARD_TRIGGERS.map(rowGuardEventType)

/** 库触发器事件的共同忽略原因（写进 `event_inbox.route_error`）。 */
const ROW_GUARD_IGNORED_REASON =
  '库触发器 fn_row_guard 写的状态迁移审计事实（normalizer_version=schema/0001，'
  + 'RuntimeStore.listPendingEvents 不把它当待路由触发事件）；后续工作由发出该迁移的命令路径负责，'
  + '事件再做一次自动触发会让同一次状态变化执行两遍。'

/** 工具 / 领域写路径发射的事件（名字逐字，登记后由机检保证发射方引用）。 */
const WRITER_EVENTS: readonly EventTypeDefinition[] = [
  {
    type: EVENT_TYPES.RESUME_INTAKE_RECEIVED,
    constKey: 'RESUME_INTAKE_RECEIVED',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/application-intake.ts',
      detail: 'upsertIntakeEvent()（工具 recruitment_application_intake：S6 材料到达）',
    },
    // 唯一一个"进待路由队列"的 S6 事件：intake/1.0.0 不在 schema/0001 的排除范围。
    normalizerVersion: 'intake/1.0.0',
    routing: {
      kind: 'DETERMINISTIC',
      taskType: 'RESUME_PARSE',
      title: '解析新收到的简历',
      // 常规后台（3 = BACKGROUND）：材料到达由后台工具摄取，没有人在页面上等解析结果。
      priority: PRIORITY_BANDS.BACKGROUND,
      object: {
        // 为什么是 INTAKE_RECORD 而不是 APPLICATION：intake 在**写事件之后**才建
        // application（application-intake.ts step 6 写事件 → step 7 ensureActiveApplication），
        // 且同一份材料（同一 sha256、同一事件）可被多个 application 复用。与该事件
        // 1:1 的业务对象是 `intake_record`（`intake_record.event_id` = 本事件）。
        type: 'INTAKE_RECORD',
        fields: ['intake_record_id'],
        byEventRow: 'INTAKE_RECORD',
      },
    },
  },
  {
    type: EVENT_TYPES.SCORECARD_SUBMIT,
    constKey: 'SCORECARD_SUBMIT',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/scorecard-submit.ts',
      detail: 'insertInternalEvent()（工具 recruitment_scorecard_submit：S10 面评提交）',
    },
    // 该插入点没写 normalizer_version（NULL），所以会进待路由队列。
    normalizerVersion: null,
    routing: {
      kind: 'DETERMINISTIC',
      taskType: 'EVALUATION_SYNTHESIZE',
      title: '汇总面试评价',
      // 人在等（1 = HUMAN_WAITING）：面试官在页面提交面评后等汇总，必须能被先认领。
      priority: PRIORITY_BANDS.HUMAN_WAITING,
      object: {
        type: 'INTERVIEW',
        fields: ['interview_id'],
        byEventRow: null,
      },
    },
  },
  {
    type: EVENT_TYPES.DECISION_RECORD,
    constKey: 'DECISION_RECORD',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/decision-record.ts',
      detail: 'insertDecisionEvent()（工具 recruitment_decision_record：人工决策落库）',
    },
    normalizerVersion: 'schema/evaluation-2.0.0',
    routing: {
      kind: 'IGNORED',
      reason:
        '人工决策的审计事实：决定已由工具在同一事务里写进 decision 表（并按 scope 推进阶段）；'
        + 'v1.0 没有"记录决策后自动执行"的任务类型，再建任务会重复推进。'
        + '（不缺业务对象 id —— payload 带 application_id，是**明确不触发**，不是解析失败。）',
    },
  },
  {
    type: EVENT_TYPES.INTERVIEW_RESCHEDULED,
    constKey: 'INTERVIEW_RESCHEDULED',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/interview-schedule.ts',
      detail: 'insertInternalEvent()（工具 recruitment_interview_schedule：RESCHEDULE）',
    },
    normalizerVersion: 'schema/interview-schedule',
    routing: {
      kind: 'IGNORED',
      reason:
        '改期已由工具在同一事务内写幂等 STORE Task（INTERVIEW_SCHEDULE / INTERVIEW_MEETING_BIND）'
        + '并补绑 meeting；事件只是审计事实（cancel/reschedule 理由只能落事件 payload），'
        + '再自动触发会让同一次改期执行两遍。',
    },
  },
  {
    type: EVENT_TYPES.INTERVIEW_CANCELLED,
    constKey: 'INTERVIEW_CANCELLED',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/interview-schedule.ts',
      detail: 'insertInternalEvent()（工具 recruitment_interview_schedule：CANCEL）',
    },
    normalizerVersion: 'schema/interview-schedule',
    routing: {
      kind: 'IGNORED',
      reason:
        '取消已由工具在同一事务内完成状态迁移与 STORE Task（INTERVIEW_SCHEDULE）；'
        + '事件是审计事实（取消理由只能落事件 payload），不需要二次触发。',
    },
  },
  {
    type: EVENT_TYPES.INTERVIEWER_WITHDRAWN,
    constKey: 'INTERVIEWER_WITHDRAWN',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/interview-schedule.ts',
      detail: 'insertInternalEvent()（工具 recruitment_interview_schedule：WITHDRAW_INTERVIEWER）',
    },
    normalizerVersion: 'schema/interview-schedule',
    routing: {
      kind: 'IGNORED',
      reason:
        '撤换面试官后需要重新安排，但 v1.0 没有对应的自动任务类型；事件登记为审计事实，'
        + '由人工/后续版本处理（不猜一个任务类型来假装自动）。',
    },
  },
  {
    type: EVENT_TYPES.JOB_RUBRIC_VERSION_APPROVED,
    constKey: 'JOB_RUBRIC_VERSION_APPROVED',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/job-rubric-approve.ts',
      detail: 'insertApprovalEvent()（工具 recruitment_job_rubric_approve：rubric 批准）',
    },
    normalizerVersion: 'schema/0001',
    routing: {
      kind: 'IGNORED',
      reason:
        'rubric 批准已由命令事务写库（版本 + approval + job.current_rubric_version_id 指针）；'
        + '事件是 schema/0001 口径的审计事实，不进待路由队列。',
    },
  },
  {
    type: EVENT_TYPES.INTERVIEW_RECORD_VERIFIED,
    constKey: 'INTERVIEW_RECORD_VERIFIED',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/interview-record-verify.ts',
      detail: 'insertRecordVerifiedEvent()（工具 recruitment_interview_record_verify：人工核验面试记录）',
    },
    // 该插入点写 normalizer_version='schema/0001'（与状态护栏审计事件同一口径）。
    normalizerVersion: 'schema/0001',
    routing: {
      kind: 'IGNORED',
      reason:
        '记录核验已由命令事务写库（interview_record 两条状态轴 + fn_row_guard 的状态迁移审计'
        + ' interview_record.status.changed）；本事件是 schema/0001 口径的审计事实，'
        + '不进待路由队列，也没有需要自动执行的后续工作（决策侧读的是库里的 VERIFIED 状态，不是事件）。',
    },
  },
  {
    type: EVENT_TYPES.APPLICATION_RUBRIC_VERSION_PINNED,
    constKey: 'APPLICATION_RUBRIC_VERSION_PINNED',
    producer: {
      kind: 'DOMAIN_WRITER',
      file: 'src/domain/stage-advance.ts',
      detail: 'insertAuditEvent()（阶段推进时 pin rubric 版本）',
    },
    normalizerVersion: 'schema/0001',
    routing: {
      kind: 'IGNORED',
      reason:
        'pin rubric 已由阶段推进的命令事务完成；事件是 schema/0001 口径的审计事实，'
        + '不进待路由队列，也没有需要自动执行的后续工作。',
    },
  },
  {
    type: EVENT_TYPES.JOB_CLOSED,
    constKey: 'JOB_CLOSED',
    producer: {
      kind: 'HTTP_ACTION',
      file: 'src/http/actions-job.ts',
      detail: 'closeJobInTransaction()（岗位关闭 Host Remote Action）',
    },
    normalizerVersion: 'schema/job-close',
    routing: {
      kind: 'IGNORED',
      reason:
        '岗位关闭已在同一事务里终止在途申请/未开始面试/未完成任务，并由 fn_row_guard 写各状态迁移审计；'
        + '本事件是聚合审计事实，不建任务、不再自动执行，否则会重复终止。',
    },
  },
  {
    type: EVENT_TYPES.CRITERION_OVERRIDE_RECORDED,
    constKey: 'CRITERION_OVERRIDE_RECORDED',
    producer: {
      kind: 'TOOL',
      file: 'src/tools/criterion-override.ts',
      detail: 'insertOverrideRecordedEvent()（工具 recruitment_criterion_override：逐条标准人工纠偏落库）',
    },
    // 与 interview.record.verified / job.rubric_version.approved 同一口径：纯审计工具事件用
    // normalizer_version='schema/0001'，RuntimeStore.listPendingEvents 不把它当待路由触发事件。
    normalizerVersion: 'schema/0001',
    routing: {
      kind: 'IGNORED',
      reason:
        '人工逐条纠偏已由工具在同一事务写进 criterion_override 表并把旧 current 收口；'
        + '事件只是审计事实（时间线可读），v1.0 没有自动后续任务，再建任务会重复处理。'
        + '（payload 带 application_id，是**明确不触发**，不是对象 id 解析失败。）',
    },
  },
]

/** 库触发器派生的事件（19 个，全部 IGNORED，原因统一）。 */
const ROW_GUARD_EVENTS: readonly EventTypeDefinition[] = ROW_GUARD_TRIGGERS.map((trigger) => ({
  type: rowGuardEventType(trigger),
  constKey: null,
  producer: {
    kind: 'DB_TRIGGER' as const,
    file: 'db/migrations/0001_init.sql',
    detail: `fn_row_guard('${trigger.column}') on recruitment.${trigger.table}（§9.2 状态护栏）`,
  },
  normalizerVersion: 'schema/0001',
  routing: { kind: 'IGNORED' as const, reason: ROW_GUARD_IGNORED_REASON },
}))

/**
 * 全部已登记的事件类型。
 *
 * **这是唯一一份**：改它 = 改事件契约。加新事件必须先在这里登记，否则
 * `test/runtime/event-types.test.ts` 会红。
 */
export const EVENT_TYPE_REGISTRY: readonly EventTypeDefinition[] = [
  ...WRITER_EVENTS,
  ...ROW_GUARD_EVENTS,
]

/** 事件名的规范化：小写、`-`/空格 → `_`，去掉首尾空白（查表键）。 */
export function normalizeEventType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** 规范名 → 登记项（发射方写库的字面量按规范化后的键查）。 */
const REGISTRY_BY_NAME: ReadonlyMap<string, EventTypeDefinition> = new Map(
  EVENT_TYPE_REGISTRY.map((definition) => [normalizeEventType(definition.type), definition]),
)

/**
 * 查一个事件类型的登记项。
 * @param value - 事件的 `event_type` 原文（大小写/连字符会被规范化）。
 * @returns 登记项；未登记返回 `null`（调用方决定走语义 Gate，不等于"忽略"）。
 */
export function eventTypeRegistration(value: string): EventTypeDefinition | null {
  return REGISTRY_BY_NAME.get(normalizeEventType(value)) ?? null
}

/** 全部已登记的事件名（READ-ONLY；机检与文档用）。 */
export const REGISTERED_EVENT_TYPES: readonly string[] = EVENT_TYPE_REGISTRY.map((definition) => definition.type)

/** 确定性事件（要建/唤醒 Business Task）的登记项。 */
export const DETERMINISTIC_EVENT_TYPES: readonly EventTypeDefinition[] = EVENT_TYPE_REGISTRY.filter(
  (definition): definition is EventTypeDefinition & { routing: Extract<EventRouting, { kind: 'DETERMINISTIC' }> } =>
    definition.routing.kind === 'DETERMINISTIC',
)

/** 显式忽略（不建任务）的事件登记项。 */
export const IGNORED_EVENT_TYPES: readonly EventTypeDefinition[] = EVENT_TYPE_REGISTRY.filter(
  (definition) => definition.routing.kind === 'IGNORED',
)

/** 机检：规范名必须是 `<对象>.<动作>` 形态的小写点分名（库触发器名也满足）。 */
export const EVENT_TYPE_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/
