// 恢复计划类型（docs/19 §3 U2 行）。
//
// 计划的边界：本层只**生成计划**，不发起任何模型调用、不渲染页、不写库。
// 视觉补读的执行路径是既有的 `recruitment_page_image` + DSH `read_image`
// （D-81：不为兜底新建模型客户端/独立 Agent Loop），由 U3 在真实 DSH Agent 里触发。

import type { Assessment, EvidenceLocator, ReaderFacts, SuggestedAction } from '../quality/types.ts'

/** 责任角色（封闭集）。计划项必须指定一个，不允许「待定」。 */
export type ResponsibilityRole = 'reader_service' | 'agent' | 'recruiter' | 'engineering'

/** 视觉补读的渲染参数：镜像 recruitment_page_image 的真实约束，不另造一套。 */
export interface VisionRender {
  readonly tool: 'recruitment_page_image'
  /** 渲染参数；path 由调用方给（计划里不放绝对路径）。 */
  readonly args: { readonly page: number }
  readonly dpi: 200
  readonly dpi_source: 'RESUME_FALLBACK_DPI 或内置默认 200（工具不接收逐次 dpi 参数）'
  readonly format: 'png'
  readonly page_1_based: true
  /** 渲染之后谁真正「读」图：DSH 的 read_image（模型），不是本插件。 */
  readonly consumer: 'read_image'
}

/** 一页/一帧需要视觉补读的请求。 */
export interface VisionPageRequest {
  readonly kind: 'pdf_page' | 'image_frame'
  readonly page: number | null
  readonly frame: number | null
  readonly reason_codes: ReadonlyArray<string>
  readonly locator: EvidenceLocator | null
  readonly render: VisionRender | null
  readonly read_with: 'read_image'
  readonly model_needed: true
}

export interface RetryPayload {
  readonly max_attempts: number
  /** 重试用尽后落到哪里（不允许无限重试，docs/19 §2.3）。 */
  readonly on_exhausted: 'human_review'
  readonly backoff_ms: ReadonlyArray<number>
}

export interface SwitchReaderPayload {
  /** 当前读取器（未声明时为空串）。 */
  readonly from: string
  /** 需要的读取能力（不是伪造的 reader_id 清单）。 */
  readonly candidates: ReadonlyArray<string>
  readonly why: string
  /** 明确边界：reader_id 由读取器注册表提供，本层不新造读取器。 */
  readonly registry: 'reader_id 由 U1/U3 的读取器注册表提供；本层只声明所需能力'
}

export interface HumanPayload {
  readonly ask: string
  /** 人工确认产生的动作（docs/19 §2.2.6：确认/修订/仍无法识别）。 */
  readonly options: ReadonlyArray<'confirm' | 'amend' | 'still_unreadable'>
  /** 问题解除后从哪一步继续（不重新创建 Candidate/Application）。 */
  readonly resume_from: 'quality_gate'
}

export interface RecoveryStep {
  readonly step_id: string
  readonly action: SuggestedAction
  readonly role: ResponsibilityRole
  /** true = 该步未完成前不得进入可信结构化/S7。 */
  readonly blocking: boolean
  readonly codes: ReadonlyArray<string>
  /** 具体问题（人读的一句话，含受影响范围）。 */
  readonly problem: string
  /** 原文定位（可能为空 = 整份材料层面，此时 problem 会说明）。 */
  readonly locators: ReadonlyArray<EvidenceLocator>
  readonly status: 'planned' | 'blocked'
  readonly blocked_reason: string | null
  /** 该步是被哪个动作降级而来的（例如 vision_read 不可用时降到 human_review）。 */
  readonly fallback_from: SuggestedAction | null
  readonly retry: RetryPayload | null
  readonly switch_reader: SwitchReaderPayload | null
  readonly vision: ReadonlyArray<VisionPageRequest>
  readonly human: HumanPayload | null
}

export interface RecoverySummary {
  readonly total: number
  readonly blocking_steps: number
  readonly by_action: Readonly<Record<string, number>>
  readonly by_role: Readonly<Record<string, number>>
  readonly vision_pages: ReadonlyArray<number>
}

export interface RecoveryPlan {
  readonly plan_version: '1'
  readonly plan_id: string
  readonly blocking: boolean
  /** 下游下一步：结构化的前提。 */
  readonly next: 'structure' | 'repair' | 'human'
  /** 该计划是否依赖多模态模型（视觉补读）。 */
  readonly requires_model: boolean
  readonly model_image_support: 'assumed' | 'supported' | 'unsupported'
  readonly steps: ReadonlyArray<RecoveryStep>
  readonly vision: ReadonlyArray<VisionPageRequest>
  readonly summary: RecoverySummary
  readonly notes: ReadonlyArray<string>
  /** 一致性问题：把同一次判定结果一起交出去，避免下游二次判定出现分歧。 */
  readonly assessment: Assessment
}

export interface PlanOptions {
  /** 复用已有判定（不给就内部调 assess）。 */
  readonly assessment?: Assessment
  /** 读取器事实（页数/顺序声明/原生字符数与 URI 清单），透传给 assess。 */
  readonly facts?: ReaderFacts
  /** 当前 model 是否支持图像。默认 'assumed'（未验证，不得当作已支持）。 */
  readonly model_supports_image?: boolean
  /** 单次计划最多补读多少页（超出转人工，避免一次拉爆上下文）。 */
  readonly max_vision_pages?: number
  /** 重试预算，默认 1。 */
  readonly max_retries?: number
}
