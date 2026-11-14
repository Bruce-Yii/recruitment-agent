// 面板渲染层：**只**把 `useOverview()` 交给它的数据渲染出来。
//
// 这一版故意最朴素（纯文本列表 + 空状态一句），因为本版要证明的是
// "插件注册链路 + 宿主只读路由"通了，不是视觉交付。之后同事的 HTML 界面
// 到位时，替换本文件即可：取数与归一化在 `use-overview.ts`，不在这里。
//
// 三条硬约束（验收口径）：
//   1. 空列表显示「没有等你决定的事」——不显示 `0 条 undefined` 这类东西。
//   2. 任何缺失字段都在数据层被收紧成 '' / 0 / []，因此这里不出现 `NaN`/`undefined`。
//   3. 读库失败显示错误文本，**不**伪装成"没有待办"（那会把故障说成空台账）。

import { useOverview } from './use-overview.ts'

/**
 * 「待人工决定」工作台主体（main 面板内容）。
 * @returns 面板 JSX。
 */
export function Workbench() {
  const { data, error, loading, reload } = useOverview()
  const pending = data?.pending ?? []
  const issues = data?.issues ?? []
  const configured = data?.configured ?? false
  const pendingTotal = data?.counts.pending_total ?? 0
  const activeApplications = data?.counts.active_applications ?? 0
  const byStageEntries = Object.entries(data?.counts.by_stage ?? {})

  return (
    <section>
      <h2>待人工决定</h2>
      <p>下面这些申请在等一个真人做决定。</p>

      {error !== undefined ? <p role="alert">读取失败：{error}</p> : null}

      {data !== undefined && !configured ? (
        <p>
          数据库未配置，暂时读不到数据
          {issues.length > 0 ? `（缺少：${issues.join('；')}）` : ''}
        </p>
      ) : null}

      {loading ? <p>正在读取…</p> : null}

      {!loading && error === undefined && configured ? (
        pending.length === 0 ? (
          <p>没有等你决定的事</p>
        ) : (
          <ul>
            {pending.map((row) => (
              <li key={row.application_id}>
                <p>申请：{row.application_id}</p>
                <p>阶段：{row.stage_code}</p>
                <p>为什么等：{row.reason}</p>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {data !== undefined ? (
        <p>
          待人工决定 {pendingTotal} 条；在办申请 {activeApplications} 条。
        </p>
      ) : null}

      {byStageEntries.length > 0 ? (
        <p>
          按阶段：
          {byStageEntries.map(([stageCode, count]) => `${stageCode} ${count} 条`).join(' · ')}
        </p>
      ) : null}

      <p>
        <button type="button" onClick={reload} disabled={loading}>
          刷新
        </button>
      </p>
    </section>
  )
}

export default Workbench
