// render 口径 helper（O1 残留修复轮）：模型读到的**人话**里不放内部编号。
//
// 病根：DSH 只把 `output.render(args, value)` 产出的 ContentBlock 交给模型看
// （`docs/subsystems/tools.zh.md`：`render(args, value): ContentBlock[] — Pure replayable
// presentation projection`），结构化 `value` 不进模型上下文。所以以前直接把
// `job_id=<完整 UUID>` / `sha256=<完整 64hex>` 写进 render，模型就会照着念给 HR。
//
// 三条口径（全仓统一，机检：`test/unit/product-fix-render-no-internal-ids.test.ts`）：
//   1. 人读正文只放**业务标识**（姓名 / 岗位 code+标题 / 第几轮 / 阶段）或**短号**；
//   2. 短号 = UUID 末 4 位 `…0701`；短 hash = 前 8 位 `aba19e40…`；
//   3. 只有"模型必须原样复制才能调下游工具"的 id 才允许出现完整值，且**只能**在
//      `machine arguments` 区（header 逐字带"不要给用户看"的告诫，行首缩进 2 空格）。
//
// 结构化 `value` 一律保持完整 id/hash：下游、机检、机机调用都依赖它们。

/** render 用的机器参数区 header（机检按这段字面量放行，见文件头第 3 条）。 */
export const MACHINE_ARGS_HEADER =
  'machine arguments (copy verbatim into tool calls; never show ids or hashes to the human):'

/**
 * render 用短号：只取 id 末 4 位（`…0701`）。完整 id 仍在结构化值里。
 * @param id - 完整 UUID（或任意 id 文本）。
 * @returns 短号；过短的 id 原样返回（避免退回完整值）。
 */
export function shortRef(id: string | null | undefined): string {
  if (id === null || id === undefined) return '—'
  return id.length <= 4 ? id : `…${id.slice(-4)}`
}

/**
 * render 用短 hash：前 8 位 + `…`（`aba19e40…`，与 `job_get` 既有口径一致）。
 * @param hash - 完整 sha256 / payload hash。
 * @returns 短 hash；过短的 hash 原样返回。
 */
export function shortHash(hash: string | null | undefined): string {
  if (hash === null || hash === undefined) return '—'
  return hash.length <= 8 ? hash : `${hash.slice(0, 8)}…`
}

/** 机器参数区的一条键值（键 = 下游工具真正接受的参数名）。 */
export interface MachineArgument {
  /** 下游工具的参数名（例如 `job_id`）。 */
  readonly key: string
  /** 完整值（UUID / hash）。 */
  readonly value: string
}

/**
 * 造机器参数区的行（header + 缩进 2 空格的 `key=value` 行）。
 * 空列表返回空数组（不写 header —— 没有机器参数时不留噪音）。
 * @param entries - 需要模型原样复制的完整值。
 * @returns 可直接 `lines.push(...)` 的行。
 */
export function machineArgumentLines(entries: readonly MachineArgument[]): string[] {
  const present = entries.filter((entry) => entry.value !== '')
  if (present.length === 0) return []
  return [
    MACHINE_ARGS_HEADER,
    ...present.map((entry) => `  ${entry.key}=${entry.value}`),
  ]
}
