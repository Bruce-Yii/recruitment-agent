// Demo Actor 模块的统一出口（冻结接口见 `work/d5/w1/CONTEXT.md` §1）。
//
// 谁该 import 什么：
//   * 写工具（`src/tools/*.ts`）：`resolveWriteActor` + `ToolActorDeps`（本模块 barrel 即可）；
//   * Host Remote Action（`src/http/actor.ts`，B 负责）：`createDemoActorIdentity` /
//     `resolveSessionActor` / `normalizeSessionId` / `DEMO_SESSION_HEADER` / `parseDemoActorAlias`；
//   * `src/index.ts`（owner 装配）：`createDemoActorIdentity`，再把 `identity` 传给每个写工具。
//
// 依赖方向：`demo-actor/**` → `tools/errors.ts` / `db/pool.ts`（只有纯校验函数）；
// **不** import 任何具体工具文件，避免"工具 → demo-actor → 工具"的循环。

export * from './alias.ts'
export * from './session-registry.ts'
export * from './resolve.ts'
export * from './tool-actor.ts'
