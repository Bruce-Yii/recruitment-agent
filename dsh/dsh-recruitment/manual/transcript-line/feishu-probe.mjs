// 线 2 的手工证据：在**没有**真实飞书凭据的机器上跑一次，看适配器怎么如实说
// 「没连上、还差什么」。
//
// 运行：node manual/transcript-line/feishu-probe.mjs
//
// 本脚本只读环境变量**存在性**，不打印任何值；它不发起请求、不调用 Lark CLI。
// 退出码恒 0：Gate 是 BLOCKED，这不是失败，是本轮要证明的事实。
import { createFeishuMinutesAdapter } from '../../src/connectors/feishu/index.ts'

const adapter = createFeishuMinutesAdapter({})
const described = adapter.describe()

console.log(JSON.stringify(described, null, 2))
console.log(JSON.stringify(adapter.probe(), null, 2))
console.log(`LIVE_GATE=${described.live_gate}`)
