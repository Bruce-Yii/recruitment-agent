// Eval V2 — 模型无关 L3 主观裁判执行器（对齐 docs/42 §5）。
// 纪律：
//   1. 不写死任何商业模型名，读取运行时环境变量 RECRUITMENT_EVAL_MODEL_PROVIDER / RECRUITMENT_EVAL_MODEL；
//   2. 未配置模型且未注入 invoker 时，诚实返回 L3_MODEL_NOT_CONFIGURED，绝不伪造判决；
//   3. 强制执行 A/B 位置互换双跑（正序 + 反序），两轮结论不一致则 positionSwapConsistent=false（fail-closed）；
//   4. 强制要求“先引原文、后下原子 pass/fail 判决”，产出标准 L3AtomicJudgment 供 V2_L3_GRADERS 消费。
import type { L3AtomicJudgment } from './v2-graders-l3.ts'
import { getL3JudgePrompt } from './v2-l3-prompts.ts'

export interface L3JudgeInput {
  readonly graderId: string
  readonly judgeVersion: string
  readonly calibrationStatus: 'GATE_ELIGIBLE' | 'OBSERVATION_ONLY'
  readonly criterionPrompt: string
  readonly sourceMaterial: string
  readonly candidateOutput: string
}

export interface L3ModelRawDecision {
  readonly verdict: 'pass' | 'fail'
  readonly citedSourceQuote: string
  readonly rationale: string
}

export type L3ModelInvoker = (prompt: string) => Promise<L3ModelRawDecision>

export type L3JudgeRunResult =
  | { readonly status: 'L3_MODEL_NOT_CONFIGURED'; readonly reason: string }
  | { readonly status: 'OK'; readonly judgment: L3AtomicJudgment }

export function readL3RuntimeModelConfig(env: NodeJS.ProcessEnv = process.env): {
  readonly configured: boolean
  readonly provider?: string
  readonly model?: string
} {
  const provider = env.RECRUITMENT_EVAL_MODEL_PROVIDER?.trim()
  const model = env.RECRUITMENT_EVAL_MODEL?.trim()
  if (!provider || !model) return { configured: false }
  return { configured: true, provider, model }
}

// Phase 3：裁判必须返回结构化判决，否则真实 invoker 无法解析。
// 优先用 prompt registry 里锁版的 outputContract；registry 缺该维度时退回等价常量（仍 fail-closed 由 invoker 校验）。
const L3_OUTPUT_CONTRACT_FALLBACK =
  '严格只输出一个 JSON 对象（不要 markdown 代码块、不要解释文字），字段固定为 ' +
  '{"verdict":"pass"|"fail","citedSourceQuote":"<原文逐字短句>","rationale":"<简要理由>"}。'

function outputContractFor(graderId: string): string {
  const prompt = getL3JudgePrompt(graderId)
  return prompt?.outputContract ?? L3_OUTPUT_CONTRACT_FALLBACK
}

function buildOrderPrompt(input: L3JudgeInput, order: 'SOURCE_FIRST' | 'OUTPUT_FIRST'): string {
  const a = order === 'SOURCE_FIRST' ? `[原文材料]\n${input.sourceMaterial}` : `[待评产物]\n${input.candidateOutput}`
  const b = order === 'SOURCE_FIRST' ? `[待评产物]\n${input.candidateOutput}` : `[原文材料]\n${input.sourceMaterial}`
  return [
    `评测维度：${input.graderId}（版本 ${input.judgeVersion}）`,
    `判分准则：${input.criterionPrompt}`,
    '铁律：必须先引用原文材料中的逐字短句，再输出原子结论 pass 或 fail，严禁使用外部常识脑补。',
    `输出契约：${outputContractFor(input.graderId)}`,
    a,
    b,
  ].join('\n\n')
}

export async function runL3AtomicJudge(
  input: L3JudgeInput,
  options?: { readonly invoker?: L3ModelInvoker; readonly env?: NodeJS.ProcessEnv },
): Promise<L3JudgeRunResult> {
  let invoker = options?.invoker
  if (!invoker) {
    const cfg = readL3RuntimeModelConfig(options?.env)
    if (!cfg.configured) {
      return {
        status: 'L3_MODEL_NOT_CONFIGURED',
        reason: '未配置 RECRUITMENT_EVAL_MODEL_PROVIDER / RECRUITMENT_EVAL_MODEL，已诚实跳过 L3 调用（fail-closed）。',
      }
    }
    return {
      status: 'L3_MODEL_NOT_CONFIGURED',
      reason: `已检测到运行时配置 ${cfg.provider}/${cfg.model}，但需由宿主运行时注入 L3ModelInvoker 执行网络调用。`,
    }
  }

  const forward = await invoker(buildOrderPrompt(input, 'SOURCE_FIRST'))
  const swapped = await invoker(buildOrderPrompt(input, 'OUTPUT_FIRST'))
  const positionSwapConsistent = forward.verdict === swapped.verdict
  const quote = forward.citedSourceQuote.trim()
  const groundedInSource = quote.length >= 4 && input.sourceMaterial.includes(quote)

  return {
    status: 'OK',
    judgment: {
      graderId: input.graderId,
      judgeVersion: input.judgeVersion,
      calibrationStatus: input.calibrationStatus,
      verdict: positionSwapConsistent && groundedInSource && forward.verdict === 'pass' ? 'pass' : 'fail',
      positionSwapConsistent,
      citedSourceQuote: groundedInSource ? quote : '',
      rationale: !positionSwapConsistent
        ? 'A/B 位置互换后裁判结论翻转，已 fail-closed 拦截'
        : !groundedInSource
          ? '裁判引用的原文片段未出现在真实材料中，已拦截'
          : forward.rationale,
    },
  }
}
