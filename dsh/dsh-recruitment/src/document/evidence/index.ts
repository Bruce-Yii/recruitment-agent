// D-110 证据定位器（S6 证据闸门）的公开入口。
//
// 只做 re-export，不承载逻辑：
//   * `locator.ts`            —— 定位器联合类型 + sha256 + 归一化 + 三条件核验（纯函数）；
//   * `converter-adapter.ts`  —— converter 输出 → 证据闸门上下文（读字节，不连库）；
//   * `persisted.ts`          —— 持久化证据核验（只读 DB 工具没有源字节时的 sha 链 + 定位唯一 + 逐字命中）。
//
// 消费方（`src/db/identity.ts::observeIdentity` 等）从本文件 import，
// 不直接依赖内部文件名，便于后续把定位器与 `src/document/contracts` 的 locator 统一。
export * from './locator.ts'
export * from './converter-adapter.ts'
export * from './persisted.ts'
