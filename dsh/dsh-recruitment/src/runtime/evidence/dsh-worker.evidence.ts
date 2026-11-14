// 真实 DSH Worker Session 的证据脚本（**手动运行**，不进 `node --test`）。
//
// 它证明的是本 lane 最硬的一条验收：
//   Router 派发 → **真实 `dsh --profile ... --json` 子进程** → 独立 Session 建起来
//   → 模型在 agent loop 里真的调用工具（写一个带 nonce 的文件）→ final 结果回到
//   Task/Attempt/Agent Session 三层，并且 Session 结束后 Task 仍可读。
//
// 标签纪律（三处一致：本文件、src/runtime/evidence/README.md、交付报告）：
//   * `DSH_SESSION = REAL`：sessionId 来自真实 DSH headless 进程的 NDJSON；
//   * `TOOL_EXECUTION = REAL`：文件由 Worker 的工具调用写出，并且 DSH 会话日志里
//     能读到对应 tool call（不是模型自述）；
//   * `MODEL =` 运行时实际使用的 provider/model。用产品 profile 的免费档就是
//     `REAL_EXTERNAL_PROVIDER`；只有退回 mock 时才写 `TEST_DOUBLE`。
//     本脚本**不写死**标签，从 CLI 参数/环境读取并原样打印，避免事后改口径。
//
// 运行（PowerShell，示例）：
//   $env:RECRUITMENT_DB_PASSWORD='<local dev db password>'
//   $env:DSH_HOME='D:\12412\dsh-home'
//   node src/runtime/evidence/dsh-worker.evidence.ts `
//     --profile rec-worker-probe `
//     --dsh-bin 'D:\12412\recruitment-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js' `
//     --model-label 'REAL_EXTERNAL_PROVIDER:opencode-go-openai-key2/longcat-2.5-free' `
//     --runtime-version '0.2.2-rc.3'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { composeRuntime } from '../router.ts'
import { RuntimeStore } from '../store.ts'
import type { InboundEvent } from '../types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
} from '../../../test/runtime/db.ts'

interface Args {
  readonly profile: string
  readonly dshBin: string
  readonly dshHome: string | undefined
  readonly modelLabel: string
  readonly runtimeVersion: string
  readonly out: string
  readonly timeoutMs: number
  readonly permissionMode: 'read-only' | 'workspace-write' | 'danger-full-access'
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
  }
  const required = (name: string): string => {
    const value = get(name)
    if (value === undefined || value.trim() === '') throw new Error(`missing required --${name}`)
    return value
  }
  return {
    profile: required('profile'),
    dshBin: required('dsh-bin'),
    dshHome: get('dsh-home') ?? process.env.DSH_HOME,
    modelLabel: required('model-label'),
    runtimeVersion: required('runtime-version'),
    out: get('out') ?? join(process.env.TEMP ?? process.env.TMP ?? '.', `ra-runtime-evidence-${Date.now()}.json`),
    timeoutMs: Number(get('timeout-ms') ?? '240000'),
    permissionMode: (get('permission-mode') ?? 'danger-full-access') as Args['permissionMode'],
  }
}

/**
 * 递归找 DSH 会话日志。真实存储形态是
 * `<DSH_HOME>/sessions/<encoded-cwd>/<sessionId>/session.v4.jsonl.zstd`，
 * 一个文件里是**多帧 zstd** 拼接的 JSONL；Node 的 `zstdDecompressSync` 只解第一帧，
 * 所以按 zstd magic 切帧后逐帧解压再拼接。
 */
function findSessionLog(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        stack.push(full)
        continue
      }
      if (full.includes(sessionId) && (entry.endsWith('.jsonl') || entry.endsWith('.jsonl.zstd'))) return full
    }
  }
  return null
}

/** 解多帧 zstd 的 JSONL（返回全部行）。 */
function readSessionLogJsonl(path: string): Record<string, unknown>[] {
  const buffer = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts: number[] = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === magic[0] && buffer[i + 1] === magic[1] && buffer[i + 2] === magic[2] && buffer[i + 3] === magic[3]) {
      starts.push(i)
    }
  }
  const chunks: string[] = []
  for (let index = 0; index < starts.length; index += 1) {
    const slice = buffer.subarray(starts[index], index + 1 < starts.length ? starts[index + 1] : buffer.length)
    try {
      chunks.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {
      // 单帧损坏不伪造证据；后续帧继续解。
    }
  }
  const text = chunks.length > 0 ? chunks.join('') : buffer.toString('utf8')
  const out: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      // 非 JSON 行跳过。
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const db = await createRuntimeTestDatabase('evidence')
  const startedAt = new Date().toISOString()
  try {
    const store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
    const composed = composeRuntime({
      store,
      worker: {
        profile: args.profile,
        dshBin: args.dshBin,
        dshHome: args.dshHome,
        permissionMode: args.permissionMode,
        timeoutMs: args.timeoutMs,
        runtimeVersion: args.runtimeVersion,
        modelRoute: args.modelLabel,
        cwd: process.cwd(),
      },
      leaseMs: args.timeoutMs + 60_000,
      maxAttempts: 2,
      workspaceRoot: join(process.env.TEMP ?? process.env.TMP ?? '.', 'ra-runtime-worker-workspaces'),
    })

    // 1) 真实事件 → Business Task（确定性路径）
    const applicationId = randomUUID()
    const nonce = randomUUID()
    const proofDir = join(process.env.TEMP ?? process.env.TMP ?? '.', 'ra-runtime-tool-proof')
    const proofPath = join(proofDir, `tool-proof-${nonce}.txt`)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(proofDir, { recursive: true })
    const event: InboundEvent = {
      tenantId: RUNTIME_TENANT,
      provider: 'feishu',
      providerEventId: `evidence-${nonce}`,
      eventType: 'resume_received',
      occurredAt: new Date().toISOString(),
      payload: { application_id: applicationId, evidence_nonce: nonce },
      trustLevel: 'UNTRUSTED_EXTERNAL',
    }
    const received = await composed.router.submit(event)
    if (received.taskId === null) throw new Error('event was not routed to a task')

    // 2) 给任务书加上"用工具写证据文件"的可验证要求（工具执行是真的，不是模型自述）。
    await db.pool.query(
      `update recruitment.business_task
          set description = $2,
              title = $3
        where tenant_id = $1::uuid and id = $4::uuid`,
      [
        RUNTIME_TENANT,
        [
          'Runtime evidence task. This is a real DSH worker session.',
          `Use the write tool (not shell, not a claim in text) to create the file: ${proofPath}`,
          `The file content must be exactly: TOOL_EXECUTED_${nonce}`,
          'After the file exists, reply with the required single JSON object:',
          `{"state":"succeeded","summary":"tool proof written","result_ref":"${proofPath}"}`,
          'If you cannot write the file, reply state=failed with the real error.',
        ].join('\n'),
        'Runtime evidence: write a tool proof file',
        received.taskId,
      ],
    )

    // 3) Router tick：真实 DSH Worker 建 Session 并执行
    const receipt = await composed.router.tick(new AbortController().signal)
    if (receipt.dispatched === null) {
      throw new Error(`router did not dispatch: ${receipt.idleReason ?? 'unknown reason'}`)
    }
    const taskId = receipt.dispatched.taskId
    const view = await composed.tasks.read(taskId)
    if (view === null) throw new Error('task disappeared after dispatch')

    // 4) 工具副作用读回（文件存在且内容正确 = 工具真的执行了）
    const proofExists = existsSync(proofPath)
    const proofContent = proofExists ? readFileSync(proofPath, 'utf8').trim() : null
    const toolExecuted = proofExists && proofContent === `TOOL_EXECUTED_${nonce}`

    // 5) DSH 会话日志里找 tool call（第二份独立证据：DSH 自己记录的 tool/call）
    const sessionLog = view.sessions
      .map((session) => session.runtimeSessionId === null ? null : findSessionLog(args.dshHome ?? '', session.runtimeSessionId))
      .find((path) => path !== null) ?? null
    let toolCallCount = 0
    let writeCallCount = 0
    let writeCallArguments: string | null = null
    let writeCallFile: string | null = null
    let writeCallContent: string | null = null
    if (sessionLog !== null) {
      for (const event of readSessionLogJsonl(sessionLog)) {
        if (event.type !== 'tool/call') continue
        toolCallCount += 1
        const data = event.data !== null && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
        if (data.name === 'write') {
          writeCallCount += 1
          writeCallArguments = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? null)
          try {
            const parsed = JSON.parse(writeCallArguments) as Record<string, unknown>
            writeCallFile = typeof parsed.file_path === 'string' ? parsed.file_path : null
            writeCallContent = typeof parsed.content === 'string' ? parsed.content : null
          } catch {
            // 参数不是合法 JSON 就不算证明。
          }
        }
      }
    }
    const toolCallProven = writeCallCount > 0
      && writeCallFile === proofPath
      && writeCallContent === `TOOL_EXECUTED_${nonce}`

    const evidence = {
      labels: {
        provenance: toolExecuted ? 'LIVE' : 'FAILED',
        dsh_session: 'REAL',
        tool_execution: toolExecuted ? 'REAL' : 'NOT_PROVEN',
        model: args.modelLabel,
        note: 'model label is supplied by the caller and printed verbatim; no LIVE claim is made beyond the recorded facts',
      },
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      dsh_worker: {
        profile: args.profile,
        dsh_bin: args.dshBin,
        dsh_home: args.dshHome ?? null,
        permission_mode: args.permissionMode,
      },
      event: {
        event_id: received.eventId,
        outcome: received.outcome,
        dispatch_state: received.dispatchState,
        task_id: received.taskId,
        task_created: received.taskCreated,
        wake_inserted: received.wakeInserted,
      },
      tick: receipt,
      task_three_layers: {
        task_id: view.task.id,
        task_status: view.task.status,
        task_result_ref: view.task.resultRef,
        attempt_id: view.attempts.at(-1)?.id ?? null,
        attempt_no: view.attempts.at(-1)?.attemptNo ?? null,
        attempt_status: view.attempts.at(-1)?.status ?? null,
        agent_session_id: view.sessions.at(-1)?.id ?? null,
        agent_session_status: view.sessions.at(-1)?.status ?? null,
        runtime_session_id: view.sessions.at(-1)?.runtimeSessionId ?? null,
        runtime_kind: view.sessions.at(-1)?.runtimeKind ?? null,
        runtime_version: view.sessions.at(-1)?.runtimeVersion ?? null,
        model_route: view.sessions.at(-1)?.modelRoute ?? null,
      },
      tool_proof: {
        path: proofPath,
        exists: proofExists,
        content: proofContent,
        nonce,
        tool_executed: toolExecuted,
        dsh_session_log: sessionLog,
        dsh_tool_call_count: toolCallCount,
        dsh_write_call_count: writeCallCount,
        dsh_write_file: writeCallFile,
        dsh_write_content: writeCallContent,
        dsh_write_file_matches: writeCallFile === proofPath,
        dsh_write_content_matches: writeCallContent === `TOOL_EXECUTED_${nonce}`,
        dsh_tool_call_proven: toolCallProven,
      },
    }
    writeFileSync(args.out, JSON.stringify(evidence, null, 2), 'utf8')
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
    if (!toolExecuted) {
      throw new Error(`tool proof file missing or wrong content: ${proofPath}`)
    }
    if (!toolCallProven) {
      throw new Error('DSH session log does not contain a write tool/call carrying the proof path and nonce')
    }
    if (view.attempts.at(-1)?.status !== 'SUCCEEDED') {
      throw new Error(`worker did not succeed: ${view.attempts.at(-1)?.status ?? 'no attempt'}`)
    }
  } finally {
    await db.drop()
  }
}

await main()


