// Eval V2 Phase 3 — Tier B L3 校准集（合成样本）。
// 纪律：全部人物、公司、项目、数字均为虚构；不含真实姓名、手机号、邮箱或真实公司项目。
// 每条样本都把「原文事实」与「待评产物」并列，合格裁判应能明确给出 pass/fail。
// 约定：每条 sourceMaterial 末尾带「材料编号：CAL-xx（虚构合成材料，仅用于评测）」，
// 既便于离线测试定位样本，也提供统一的原文锚定短语（runL3AtomicJudge 要求引用逐字命中）。
export interface L3CalibrationSample {
  readonly sampleId: string
  /** 必须是 7 个 L3 grader 之一。 */
  readonly graderId: string
  /** 合成原文（面试转写/简历片段），无真实个资。 */
  readonly sourceMaterial: string
  /** 待评产物（面评草稿/初筛理由等）。 */
  readonly candidateOutput: string
  /** 人标：该产物是否合格。 */
  readonly humanPass: boolean
}

// 7 个 L3 维度的精确 id 集合（与 v2-graders-l3.ts 的 V2_L3_GRADERS 对齐）。
export const L3_CALIBRATION_GRADER_IDS = [
  'L3_fluff_detection',
  'L3_claim_faithfulness',
  'L3_numeric_grounding',
  'L3_speaker_attribution_exact',
  'L3_hallucination_rate',
  'L3_second_probe_collapse_caught',
  'L3_team_vs_individual_separated',
] as const

export const L3_CALIBRATION_SAMPLES: readonly L3CalibrationSample[] = [
  // ---------------------------- 合格样本（8 条） ----------------------------
  {
    sampleId: 'CAL-01',
    graderId: 'L3_numeric_grounding',
    sourceMaterial: [
      '面试官：你在上一个项目里做了多久？',
      '候选人甲：我在虚构公司星屿科技的订单重构项目里做了两年，主要负责接口分层。',
      '面试官：两年里有没有带人？',
      '候选人甲：没有带人，是和另一位同事一起做。',
      '材料编号：CAL-01（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人在订单重构项目上有两年经验，负责接口分层，未承担带人职责。',
    humanPass: true,
  },
  {
    sampleId: 'CAL-02',
    graderId: 'L3_claim_faithfulness',
    sourceMaterial: [
      '面试官：为什么离开上一家公司？',
      '候选人乙：因为团队调整，我所在的模块被合并，我想找更聚焦的方向。',
      '材料编号：CAL-02（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人因团队模块合并而离职，希望转向更聚焦的方向。',
    humanPass: true,
  },
  {
    sampleId: 'CAL-03',
    graderId: 'L3_hallucination_rate',
    sourceMaterial: [
      '面试官：你做过最熟悉的技术是什么？',
      '候选人丙：我日常用 TypeScript 写服务，配合 PostgreSQL 做查询优化，其他技术栈接触不多。',
      '材料编号：CAL-03（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人熟悉 TypeScript 服务开发与 PostgreSQL 查询优化，未声称掌握其他技术栈。',
    humanPass: true,
  },
  {
    sampleId: 'CAL-04',
    graderId: 'L3_team_vs_individual_separated',
    sourceMaterial: [
      '面试官：结算系统是谁主导的？',
      '候选人丁：那是五人小组一起完成的，我只负责其中的对账模块设计和联调。',
      '材料编号：CAL-04（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '结算系统由五人小组共同完成；候选人丁个人负责对账模块设计与联调。',
    humanPass: true,
  },
  {
    sampleId: 'CAL-05',
    graderId: 'L3_speaker_attribution_exact',
    sourceMaterial: [
      '面试官：你介意出差吗？',
      '候选人戊：不太介意，但希望提前一周通知。',
      '面试官：那我先说明，我们季度会有两次集中出差。',
      '材料编号：CAL-05（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人戊表示不介意出差，但希望提前一周获知；季度两次集中出差是面试官说明的安排。',
    humanPass: true,
  },
  {
    sampleId: 'CAL-06',
    graderId: 'L3_fluff_detection',
    sourceMaterial: [
      '面试官：举一个你解决过的具体问题。',
      '候选人己：上季度报表导出超时，我把批量查询改成游标分页，导出耗时从十分钟降到两分钟。',
      '材料编号：CAL-06（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人己定位并修复了报表导出超时问题，用游标分页把耗时由十分钟降到两分钟。',
    humanPass: true,
  },
  {
    sampleId: 'CAL-07',
    graderId: 'L3_second_probe_collapse_caught',
    sourceMaterial: [
      '面试官：你说你负责缓存方案，具体怎么做？',
      '候选人庚：我设计了缓存分层。',
      '面试官：追问一下，缓存失效时怎么办？',
      '候选人庚：这个我没想过，当时是同事处理的。',
      '材料编号：CAL-07（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人庚自称设计缓存分层，但二轮追问后承认未考虑缓存失效场景，该部分由同事处理。',
    humanPass: true,
  },
  {
    sampleId: 'CAL-08',
    graderId: 'L3_claim_faithfulness',
    sourceMaterial: [
      '面试官：你目前的汇报对象是谁？',
      '候选人辛：我向一位技术负责人汇报，日常和三位同事协作，团队没有设置小组长。',
      '材料编号：CAL-08（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人辛向技术负责人汇报，与三位同事协作，团队没有小组长角色。',
    humanPass: true,
  },

  // ---------------------------- 坏例样本（8 条） ----------------------------
  {
    sampleId: 'CAL-09',
    graderId: 'L3_numeric_grounding',
    sourceMaterial: [
      '面试官：你在上一个项目里做了多久？',
      '候选人甲：我在虚构公司星屿科技的订单重构项目里做了两年，主要负责接口分层。',
      '面试官：两年里有没有带人？',
      '候选人甲：没有带人，是和另一位同事一起做。',
      '材料编号：CAL-09（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人有五年订单重构经验，主导接口分层设计。',
    humanPass: false, // 编造原文没有的数字（两年 → 五年）
  },
  {
    sampleId: 'CAL-10',
    graderId: 'L3_claim_faithfulness',
    sourceMaterial: [
      '面试官：你有没有做过跨团队协作？',
      '候选人乙：这个我记不清了，材料里也没写。',
      '面试官：好，我们跳过。',
      '材料编号：CAL-10（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人没有跨团队协作经历。',
    humanPass: false, // 把「读不出来」写成「没有对应」
  },
  {
    sampleId: 'CAL-11',
    graderId: 'L3_hallucination_rate',
    sourceMaterial: [
      '面试官：你做过最熟悉的技术是什么？',
      '候选人丙：我日常用 TypeScript 写服务，配合 PostgreSQL 做查询优化，其他技术栈接触不多。',
      '材料编号：CAL-11（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人主导了星屿科技的实时推荐引擎，将点击率提升了三成，并持有相关专利。',
    humanPass: false, // 凭空编造项目、指标与专利
  },
  {
    sampleId: 'CAL-12',
    graderId: 'L3_team_vs_individual_separated',
    sourceMaterial: [
      '面试官：结算系统是谁主导的？',
      '候选人丁：那是五人小组一起完成的，我只负责其中的对账模块设计和联调。',
      '材料编号：CAL-12（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人丁主导了结算系统整体设计，并完成五人小组的全部交付。',
    humanPass: false, // 把团队功劳写成个人功劳
  },
  {
    sampleId: 'CAL-13',
    graderId: 'L3_speaker_attribution_exact',
    sourceMaterial: [
      '面试官：你介意出差吗？',
      '候选人戊：不太介意，但希望提前一周通知。',
      '面试官：那我先说明，我们季度会有两次集中出差。',
      '材料编号：CAL-13（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人戊主动提出季度两次集中出差，并要求团队提前一周通知他。',
    humanPass: false, // 说话人串台：把面试官的说明写成候选人的主张
  },
  {
    sampleId: 'CAL-14',
    graderId: 'L3_fluff_detection',
    sourceMaterial: [
      '面试官：举一个你解决过的具体问题。',
      '候选人己：上季度报表导出超时，我把批量查询改成游标分页，导出耗时从十分钟降到两分钟。',
      '材料编号：CAL-14（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人己具备强烈的自驱力和结果导向，拥有优秀的 owner 意识与跨领域软技能，是团队的核心驱动力。',
    humanPass: false, // 空洞词堆砌，无原文证据
  },
  {
    sampleId: 'CAL-15',
    graderId: 'L3_second_probe_collapse_caught',
    sourceMaterial: [
      '面试官：你说你负责缓存方案，具体怎么做？',
      '候选人庚：我设计了缓存分层。',
      '面试官：追问一下，缓存失效时怎么办？',
      '候选人庚：这个我没想过，当时是同事处理的。',
      '材料编号：CAL-15（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '候选人庚完整设计了缓存分层与失效预案，具备独立闭环能力。',
    humanPass: false, // 忽略二轮追问崩塌
  },
  {
    sampleId: 'CAL-16',
    graderId: 'L3_hallucination_rate',
    sourceMaterial: [
      '面试官：你对加班怎么看？',
      '候选人壬：我愿意在项目高峰期配合，但希望节奏可预期。',
      '面试官：明白了。',
      '材料编号：CAL-16（虚构合成材料，仅用于评测）',
    ].join('\n'),
    candidateOutput: '面评意见：候选人必须无条件接受加班；面试官要求其当场解释为何不能接受，否则不予通过。',
    humanPass: false, // 审讯式/命令式话术 + 编造原文没有的对话
  },
]

/** 裁判引用锚定短语：所有合成样本都包含该逐字片段，便于离线假 invoker 满足原文锚定约束。 */
export const L3_CALIBRATION_SOURCE_ANCHOR = '虚构合成材料，仅用于评测'
