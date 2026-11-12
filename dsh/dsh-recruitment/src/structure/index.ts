// 结构层 barrel：序列化 + 校验，全部是纯函数（无 I/O、无模型、无网络）。
//
// 注意：本文件**没有**接进 src/index.ts（那不在本层的写范围内）。
// 按 E4/R2，这一层目前只能由测试与验收脚本调用，不能从插件运行入口到达。
export * from './serialize.ts'
export * from './validate.ts'
