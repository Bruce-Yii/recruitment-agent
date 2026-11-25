// Eval V2 Phase 3 — L3 主观裁判 Prompt 版本注册表（对齐 docs/42 §5 铁律 & docs/45 Phase 3）。
//
// 纪律：
//   1. 每个维度都必须“先引原文逐字短句 → 再下原子 pass/fail”，严禁外部常识脑补、改写或替换原文；
//   2. promptSha256 由内容确定性计算（criterionPrompt + '\n' + outputContract），不手写常量；
//   3. 未知 graderId → null（fail-closed），绝不返回无准则的裁判 prompt。
import { createHash } from 'node:crypto'

/** Prompt 注册表整体版本；准则内容变更必须升级此版本（lane B 据此锁定 judgeVersion/promptVersion）。 */
export const L3_JUDGE_PROMPT_REGISTRY_VERSION: string = 'l3-prompts-v1'

export interface L3JudgePrompt {
  readonly graderId: string
  readonly judgeVersion: string
  readonly promptVersion: string
  readonly criterionPrompt: string
  readonly outputContract: string
  readonly promptSha256: string
}

/** docs/42 §5 的铁律短句：所有维度共用，确保“引原文 → 下判决”不被维度特化规则稀释。 */
const IRON_LAW =
  '判决前必须先在 citedSourceQuote 中逐字引用[原文材料]的短句，再给出原子 verdict=pass 或 fail；严禁凭外部常识脑补，不得改写、替换或用近义表述替代原文。'

/** 统一的严格 JSON 输出契约。 */
const OUTPUT_CONTRACT =
  '严格只输出一个 JSON 对象（不要 markdown 代码块、不要解释文字），字段固定为 ' +
  '{"verdict":"pass"|"fail","citedSourceQuote":"<原文逐字短句>","rationale":"<简要理由>"}；' +
  'verdict 只能是 pass 或 fail；citedSourceQuote 必须是原文中真实存在的逐字短句；rationale 为可选字符串。'

interface L3JudgePromptSpec {
  readonly graderId: string
  readonly criterionPrompt: string
}

/** 顺序与 v2-graders-l3.ts 的 7 个 graderId 对齐。 */
const PROMPT_SPECS: readonly L3JudgePromptSpec[] = [
  {
    graderId: 'L3_fluff_detection',
    criterionPrompt:
      '核对[待评产物]是否把原文中的空洞水分（泛泛而谈、无事实支撑的形容词堆砌）如实拆解，而非美化成具体成果；只有原文明确写出的具体事实才可作为通过依据。' +
      IRON_LAW,
  },
  {
    graderId: 'L3_claim_faithfulness',
    criterionPrompt:
      '核对[待评产物]对候选人经历与事实的每一项陈述是否与[原文材料]逐字一致；任何超出原文范围或被改写的断言即 fail。' +
      IRON_LAW,
  },
  {
    graderId: 'L3_numeric_grounding',
    criterionPrompt:
      '核对[待评产物]中的每个数字（时长、人数、百分比、金额、年份）都能在[原文材料]找到逐字出处；任一数字无原文出处或被改写即 fail。' +
      IRON_LAW,
  },
  {
    graderId: 'L3_speaker_attribution_exact',
    criterionPrompt:
      '核对[待评产物]中每句话的说话人归属是否与[原文材料]的明确标注一致；把面试官的科普或引导语算到候选人头上即 fail，归属不明时不得猜测。' +
      IRON_LAW,
  },
  {
    graderId: 'L3_hallucination_rate',
    criterionPrompt:
      '核对[待评产物]是否零编造：原文没有的人名、公司、项目、数字或结论均视为幻觉，出现任一幻觉即 fail。' +
      IRON_LAW,
  },
  {
    graderId: 'L3_second_probe_collapse_caught',
    criterionPrompt:
      '核对[待评产物]是否如实捕获二轮追问中暴露的短板或前后矛盾，而不是沿用首轮结论；原文中已经出现的崩塌事实未被指出即 fail。' +
      IRON_LAW,
  },
  {
    graderId: 'L3_team_vs_individual_separated',
    criterionPrompt:
      '核对[待评产物]是否把团队共同成果与个人具体动作分开陈述；把团队功劳记到个人头上、或抹去原文明确的个人贡献即 fail。' +
      IRON_LAW,
  },
]

const JUDGE_VERSION = 'l3-judge-v1'
const PROMPT_VERSION = '2026-11-26'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const REGISTRY: readonly L3JudgePrompt[] = Object.freeze(
  PROMPT_SPECS.map((spec): L3JudgePrompt =>
    Object.freeze({
      graderId: spec.graderId,
      judgeVersion: JUDGE_VERSION,
      promptVersion: PROMPT_VERSION,
      criterionPrompt: spec.criterionPrompt,
      outputContract: OUTPUT_CONTRACT,
      promptSha256: sha256(spec.criterionPrompt + '\n' + OUTPUT_CONTRACT),
    }),
  ),
)

const BY_ID: ReadonlyMap<string, L3JudgePrompt> = new Map(REGISTRY.map((p) => [p.graderId, p]))

/** 未知 graderId → null（fail-closed），不抛错。 */
export function getL3JudgePrompt(graderId: string): L3JudgePrompt | null {
  return BY_ID.get(graderId) ?? null
}

export function listL3JudgePrompts(): readonly L3JudgePrompt[] {
  return REGISTRY
}

/**
 * 拼装最终裁判 prompt：维度准则 + 输出契约 + 原文材料 + 待评产物。
 * 未知 graderId 直接抛错（fail-closed，绝不构造没有准则的裁判 prompt）。
 */
export function buildL3JudgePrompt(input: {
  readonly graderId: string
  readonly sourceMaterial: string
  readonly candidateOutput: string
}): string {
  const spec = getL3JudgePrompt(input.graderId)
  if (!spec) {
    throw new Error(`未知的 L3 graderId：${input.graderId}（fail-closed，拒绝构造无准则裁判 prompt）`)
  }
  return [
    `评测维度：${spec.graderId}（judgeVersion ${spec.judgeVersion}，promptVersion ${spec.promptVersion}，registry ${L3_JUDGE_PROMPT_REGISTRY_VERSION}）`,
    `判分准则：${spec.criterionPrompt}`,
    `输出契约：${spec.outputContract}`,
    `[原文材料]\n${input.sourceMaterial}`,
    `[待评产物]\n${input.candidateOutput}`,
  ].join('\n\n')
}
