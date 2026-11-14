// 真实飞书妙记读取证据（2026-11-14，D-1 MANUAL 路径）。
//
// 用途：用**产品自己的传输层**（`src/connectors/feishu/transport.ts`）对本机
// 真实 lark-cli 读一次，把「token / 字节数 / sha256 / 回执 / 重读哈希 / gate」
// 写成 JSON 证据。**不写正文**（R7：真实转写正文不入库、不落盘、不进日志）。
//
// 运行：
//   node evidence/experiments/2026-11-14-feishu-live-read/run-live-read.mjs
//
// 前置：本机已安装并登录 lark-cli（user identity），默认 exe 路径见
// `DEFAULT_CLI_EXE`，可用环境变量 `FEISHU_CLI_EXE` 覆盖（必须是绝对路径）。
//
// 说明：adapter 的凭据存在性检查用的是**进程内占位值**（只判非空布尔，不打印、
// 不落盘、不参与鉴权）；真实鉴权由 lark-cli 的 user profile 完成。这是 D-1 的
// MANUAL 操作者读取，不是产品自有 OAuth（F2 属 P1）。
import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  createLarkCliTransport,
  createProcessCliRunner,
  evaluateLiveGate,
  resolveFeishuConnector,
} from '../../../src/connectors/feishu/index.ts'

const DEFAULT_CLI_EXE = 'D:\\12412\\npm-global\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe'
const CLI_EXE = process.env.FEISHU_CLI_EXE ?? DEFAULT_CLI_EXE
const TOKENS = ['obcnvf38p9qkb3n58tak57jg', 'obcnuym8vvyv328i1y63u956']
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_JSON = join(HERE, 'live-read.json')

/** adapter 凭据存在性占位（只判非空；不打印、不落盘、不参与鉴权）。 */
const PRESENCE_ONLY_ENV = {
  FEISHU_APP_ID: 'present-only-not-used-for-auth',
  FEISHU_APP_SECRET: 'present-only-not-used-for-auth',
  FEISHU_USER_ACCESS_TOKEN: 'present-only-not-used-for-auth',
}

/** 摘要一条回读证据（**绝不含 raw_text**）。 */
function evidenceOf(readback) {
  const decision = evaluateLiveGate(readback)
  return {
    minute_token: readback.minute_token,
    transport: readback.transport,
    file_bytes: readback.file_bytes,
    transcript_chars: readback.transcript_chars,
    content_sha256: readback.content_sha256,
    reread_sha256: readback.reread_sha256 ?? null,
    read_receipt_ref: readback.read_receipt_ref,
    fetched_at: readback.fetched_at,
    revision: readback.revision ?? null,
    is_complete: readback.is_complete,
    gate: decision.gate,
    labels: decision.labels,
    provenance_basis: decision.provenance_basis,
    violations: decision.violations,
    evidence: decision.evidence,
  }
}

/** 临时工作目录残留检查（正文读完后应被删除）。 */
async function leftoverWorkDirs() {
  const entries = await readdir(tmpdir())
  return entries.filter((name) => name.startsWith('feishu-minutes-'))
}

if (!existsSync(CLI_EXE)) {
  console.error(`找不到 lark-cli：${CLI_EXE}（可用 FEISHU_CLI_EXE 指定绝对路径）`)
  process.exit(1)
}

const runner = createProcessCliRunner({ command: CLI_EXE })
const transport = createLarkCliTransport({
  runner,
  platform_channel: true,
  timeout_ms: 120_000,
  max_attempts: 1,
})

const help = await transport.verifyContract()
const records = []
for (const token of TOKENS) {
  const result = await transport.read({ minute_token: token })
  if (result.status !== 'READ') {
    records.push({
      minute_token: token,
      read_status: result.status,
      failure: result.status === 'FAILED'
        ? { stage: result.error.stage, code: result.error.code, message: result.error.message }
        : { provider_code: result.provider_code },
    })
    continue
  }
  records.push({ read_status: 'READ', ...evidenceOf(result.readback) })
}

// 产品完整出口：插件配置 → resolveFeishuConnector → adapter.fetchTranscript。
const resolved = resolveFeishuConnector(
  { cli: CLI_EXE, timeout_ms: 120_000, max_attempts: 1 },
  PRESENCE_ONLY_ENV,
)
let productPath = { assembled: resolved.transport_configured, issues: [...resolved.issues] }
if (resolved.connector !== undefined) {
  const result = await resolved.connector.adapter.fetchTranscript({ minute_token: TOKENS[0] })
  if (result.kind === 'READ') {
    productPath = {
      ...productPath,
      kind: result.kind,
      live_gate: result.live_gate,
      live_eligible: result.live_eligible,
      labels: result.labels,
      provenance_basis: result.provenance_basis,
      readback: evidenceOf(result.readback),
    }
  } else {
    productPath = { ...productPath, kind: result.kind, blocked_reason: result.blocked_reason, error_code: result.error_code }
  }
}

const described = transport.describe()
const evidence = {
  experiment: 'feishu-live-read',
  date: '2026-11-14',
  decision: 'D-1（provenance=LIVE + trigger=MANUAL + 真实 provider artifact ID/revision/hash/readback = demo gate 合格）',
  cli: {
    path: CLI_EXE,
    basename: basename(CLI_EXE),
    platform_channel: true,
    argument_flags_verified: described.argument_flags_verified,
    envelope_verified: described.envelope_verified,
    contract_checked_at: described.contract_checked_at,
    missing_flags: [...described.missing_flags],
    help_exit_code: help.help_exit_code,
  },
  reads: records,
  product_path: productPath,
  r7: {
    raw_text_stored_here: false,
    raw_text_printed: false,
    temp_workdirs_leftover: await leftoverWorkDirs(),
    note: '正文只在读取进程内存里出现过：算完 sha256 后临时目录已删除；本文件只记 token / 字节数 / 哈希 / 回执。',
  },
  generated_at: new Date().toISOString(),
}

await writeFile(OUT_JSON, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  json: OUT_JSON,
  help: { argument_flags_verified: evidence.cli.argument_flags_verified, envelope_verified: evidence.cli.envelope_verified },
  reads: evidence.reads.map((record) => ({
    token: record.minute_token,
    status: record.read_status,
    bytes: record.file_bytes,
    sha: record.content_sha256,
    gate: record.gate,
  })),
  product_path: { kind: evidence.product_path.kind, live_gate: evidence.product_path.live_gate },
  leftover_workdirs: evidence.r7.temp_workdirs_leftover.length,
}, null, 2))
