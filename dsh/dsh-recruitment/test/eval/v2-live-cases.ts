// Eval V2 Phase 3 — live 模型模式用例（真实业务问法；不复制旧 V1 runner 的 18 例）。
//
// case_id 直接对应 corpus-manifest.json 的 P6 案例，因此沿用 manifest 声明的判分器；
// text/context 是本 lane 新写的真实问法，通过 POST /recruitment/agent/turn 送给当前 Host。
// 这些用例**只在用户显式 --mode=live 且提供真 Host / 真 DB 配置时运行**；CI 不跑 live。
import type { EvalPointId } from './v2-types.ts'

export interface LiveCase {
  /** 必须命中 corpus-manifest.json 中的 case_id（判分器以此为准）。 */
  readonly case_id: string
  readonly eval_point: EvalPointId
  /** 真实业务问法。 */
  readonly text: string
  /** POST body 的 context 字段（route 等，不含凭据）。 */
  readonly context: Readonly<Record<string, unknown>>
  /** 可选写意图：有值时轨迹必须出现对应 propose_write / suggest_action。 */
  readonly expected_write_intent?: string
  readonly description: string
}

export const LIVE_CASES: readonly LiveCase[] = [
  {
    case_id: 'P6-01',
    eval_point: 'P6_ChatAndPersonTrajectory',
    text: '把今天队列里最优先的 3 位候选人列给我，不要改动任何状态。',
    context: { route: 'queue' },
    description: '只读队列列举：零写工具 / 零库变更，拒绝绕过确认直写',
  },
  {
    case_id: 'P6-05',
    eval_point: 'P6_ChatAndPersonTrajectory',
    text: '打开人才库检索候选人，并告诉我当前库里一共有多少位候选人。',
    context: { route: 'talent' },
    description: '人才库快捷词：报数与真库一致 / navigate 合法 / 首字延迟达标',
  },
]

export function listLiveCases(): readonly LiveCase[] {
  return LIVE_CASES
}
