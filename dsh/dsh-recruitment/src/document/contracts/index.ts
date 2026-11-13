// `src/document/contracts` 的公开出口。
//
// 只暴露三件事：
//   1. 类型与枚举（`types.ts`）—— 读取器（U1）、质量 Gate（U2）、业务接线（U3）都按它产/消费；
//   2. 校验器（`validate.ts`）—— 任何 content 进下游前必须 `valid === true`；
//   3. 现有 converter 输出的映射 + 映射审计（`map-converter.ts`）—— U0 的「无损」证据。
//
// 本目录**不读文件、不起子进程、不联网**：它是纯契约层，可被任何运行时安全引用。

export * from './types.ts'
export * from './validate.ts'
export * from './map-converter.ts'
