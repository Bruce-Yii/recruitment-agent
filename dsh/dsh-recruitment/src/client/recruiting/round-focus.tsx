// 轮次重点卡（W2 招聘方视图）：显示 task-50 `round_focus` 投影 —— 本轮来源 / 标题 / 说明 /
// 重点维度 / 建议问题 / 评分表字段 / 降级 reason。
//
// 契约出处：
//   · `work/d5/round/REPORT.md` §2：`round_focus` 字段名逐字（available/source/round_no/template_*/
//     title/description/focus_dimensions[{key,label,weight,required,in_rubric}]/questions[{key,text}]/
//     scorecard_fields[{key,label,kind,required}]/reason）；
//   · `work/d5/w2b/INTERFACE.md` §2.5：导出签名 `RoundFocusCard({ focus })` +
//     `data-testid="round-focus"` / `data-available` / `data-source` / `data-round`。
//
// 数据驱动：不同轮次不同内容全部来自 `RoundFocusView`，本组件**不**按轮次号硬编码任何文案或维度；
// `available=false` 只显示服务端 `reason`（JOB_BASE 降级必须说清原因，界面不编造本轮重点）。
// 纯展示：不取数、不写状态、不碰 localStorage。

import type { ChipTone } from './format.ts'
import { shortSha } from './format.ts'
import { Chip } from './parts.tsx'
import type { RoundFocusView } from './view-model.ts'

/** 轮次重点来源 → 展示文案（未知来源原样显示，不冒充已知枚举）。 */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  ROUND_CONFIG: '轮次配置（本轮专属）',
  JOB_BASE: '岗位 Rubric 底座（JOB_BASE 降级）',
}

/** 轮次重点来源 → chip 色档（ROUND_CONFIG 绿 / JOB_BASE 琥珀 / 未知灰）。 */
const SOURCE_TONES: Readonly<Record<string, ChipTone>> = {
  ROUND_CONFIG: 'green',
  JOB_BASE: 'amber',
}

/** 来源文案：已知枚举给中文，未知值原样返回（不吞信息）。 */
function sourceLabelOf(source: string): string {
  if (source === '') return '来源未提供'
  return SOURCE_LABELS[source] ?? source
}

/**
 * 本轮考察重点卡。
 * @param focus - 归一化后的 `round_focus`（`InterviewView.roundFocus`）。
 * @returns 轮次重点 JSX（不可用时只显示降级 reason，不编造内容）。
 */
export function RoundFocusCard({ focus }: { readonly focus: RoundFocusView }) {
  const sourceTone: ChipTone = SOURCE_TONES[focus.source] ?? 'gray'
  const roundText = focus.roundNo > 0 ? `第 ${String(focus.roundNo)} 轮` : '轮次未提供'
  const hasTemplateTrace = focus.templateVersionNo > 0 || focus.templatePayloadHash !== ''
  const hasContent =
    focus.title !== '' ||
    focus.description !== '' ||
    focus.focusDimensions.length > 0 ||
    focus.questions.length > 0 ||
    focus.scorecardFields.length > 0

  return (
    <div
      className="rcw-roundfocus"
      data-testid="round-focus"
      data-available={focus.available ? 'true' : 'false'}
      data-source={focus.source}
      data-round={String(focus.roundNo)}
    >
      <div className="rcw-roundfocus-head">
        <span className="rcw-cap">本轮考察重点</span>
        <span className="rcw-chiprow">
          <Chip tone={sourceTone} testid="round-focus-source">
            {sourceLabelOf(focus.source)}
          </Chip>
          <span className="rcw-dim rcw-tiny" data-testid="round-focus-round">
            {roundText}
          </span>
          {hasTemplateTrace ? (
            <span className="rcw-mono rcw-tiny" data-testid="round-focus-template">
              模板 {focus.templateVersionNo > 0 ? `v${String(focus.templateVersionNo)}` : '版本未提供'}
              {focus.templatePayloadHash !== '' ? ` · payload ${shortSha(focus.templatePayloadHash)}` : ''}
            </span>
          ) : null}
        </span>
      </div>

      {focus.available ? (
        <>
          {focus.title !== '' ? (
            <h3 className="rcw-roundfocus-title" data-testid="round-focus-title">
              {focus.title}
            </h3>
          ) : null}
          {focus.description !== '' ? (
            <p className="rcw-roundfocus-desc" data-testid="round-focus-description">
              {focus.description}
            </p>
          ) : null}

          {focus.focusDimensions.length > 0 ? (
            <div className="rcw-roundfocus-block" data-testid="round-focus-dimensions">
              <div className="rcw-subhead">
                <h4>本轮重点维度</h4>
                <span className="rcw-dim rcw-tiny">共 {focus.focusDimensions.length} 个</span>
              </div>
              {focus.focusDimensions.map((dimension) => (
                <div
                  className="rcw-criteria"
                  key={dimension.key}
                  data-dim-key={dimension.key}
                  data-testid={`round-focus-dimension-${dimension.key}`}
                >
                  <span className={`rcw-dot ${dimension.inRubric ? 'rcw-dot-blue' : ''}`.trim()} />
                  <div className="rcw-criteriabody">
                    <strong>
                      {dimension.label}（{dimension.key}）
                    </strong>
                    <span className="rcw-dim rcw-tiny" style={{ marginLeft: 6 }}>
                      {dimension.weight !== null ? `权重 ${String(dimension.weight)}` : '权重未提供'} ·{' '}
                      {dimension.required ? '本轮必覆盖' : '非必覆盖'} ·{' '}
                      {dimension.inRubric ? '在面评 Rubric 内' : '不在面评提交键集（仅展示）'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {focus.questions.length > 0 ? (
            <div className="rcw-roundfocus-block" data-testid="round-focus-questions">
              <div className="rcw-subhead">
                <h4>建议问题</h4>
                <span className="rcw-dim rcw-tiny">共 {focus.questions.length} 条</span>
              </div>
              <ol className="rcw-roundfocus-list">
                {focus.questions.map((question, index) => (
                  <li
                    key={question.key !== '' ? question.key : `round-focus-question-${String(index)}`}
                    className="rcw-quote"
                    data-question-key={question.key}
                    data-testid={`round-focus-question-${question.key !== '' ? question.key : String(index)}`}
                  >
                    {question.text}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {focus.scorecardFields.length > 0 ? (
            <div className="rcw-roundfocus-block" data-testid="round-focus-scorecard">
              <div className="rcw-subhead">
                <h4>评分表字段</h4>
                <span className="rcw-dim rcw-tiny">共 {focus.scorecardFields.length} 个</span>
              </div>
              <div className="rcw-tablewrap">
                <table className="rcw-table">
                  <thead>
                    <tr>
                      <th>key</th>
                      <th>字段</th>
                      <th>类型</th>
                      <th>必填</th>
                    </tr>
                  </thead>
                  <tbody>
                    {focus.scorecardFields.map((field) => (
                      <tr key={field.key} data-testid={`round-focus-field-${field.key}`}>
                        <td className="rcw-mono">{field.key}</td>
                        <td>{field.label}</td>
                        <td>{field.kind !== '' ? field.kind : '—'}</td>
                        <td>{field.required ? '是' : '否'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {!hasContent ? (
            <p className="rcw-roundfocus-desc" data-testid="round-focus-empty">
              服务端标记本轮重点可用（available=true），但没有返回标题/说明/维度/问题/评分表字段；界面不编造内容。
            </p>
          ) : null}

          {focus.reason !== '' ? (
            <p className="rcw-roundfocus-note" data-testid="round-focus-note">
              服务端附注：{focus.reason}
            </p>
          ) : null}
        </>
      ) : (
        <div className="rcw-roundfocus-degrade" data-testid="round-focus-reason">
          <Chip tone="amber">本轮重点不可用（降级）</Chip>
          <p>
            {focus.reason !== ''
              ? focus.reason
              : '服务端没有提供轮次重点配置（round_focus.available=false），界面不编造本轮重点。'}
          </p>
          <p className="rcw-muted rcw-tiny">
            当前来源：{sourceLabelOf(focus.source)}；降级内容由服务端 reason 决定，客户端不用岗位 Rubric 冒充本轮重点。
          </p>
        </div>
      )}
    </div>
  )
}

export default RoundFocusCard
