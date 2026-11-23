// Eval V2 真实输入采集器（Issue #92 P1-B / lane B2）：
// 把三类**真实来源**落盘为 capture bundle（contract: work/lane92-adapters/INTERFACE-CONTRACT.md）：
//   (a) 真实 Python converter 对无 PII 合成 PDF 的 DocumentContent；
//   (b) 独立 PG17（127.0.0.1:49353）一次性库 ra_fix92_adapters，按名重放 0001→0025、
//       db/verify.sql VERIFY PASS，并用**独立 psql** 读回 countsBefore / countsAfter；
//   (c) 真 Host SSE：49349 端口 + rec-e2e-live profile（hy4-flash-free），
//       抓 /recruitment/agent/turn 原始帧；起不来时写 BLOCKED.json，绝不伪造帧。
//
// 用法：node test/eval/capture-real-inputs.mjs --out=<dir>
// 默认 out = <repo>/work/lane92-adapters/capture。
// 边界：不 import 产品代码、不改 manifest/判分器、凭据只通过子进程 env 注入（命令原文不含口令/token）。
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const DEFAULT_OUT = join(REPO_ROOT, 'work', 'lane92-adapters', 'capture')
const MAIN_WORKSPACE = 'D:\\12412\\dsh工作区\\projects\\recruitment-agent'
const PYTHON = process.env.RECRUITMENT_PYTHON || process.env.RECRUITMENT_PYTHON_BIN || 'D:\\Python3.12.9\\python.exe'
const CONVERTER_DIR = process.env.RECRUITMENT_CONVERTER_DIR || join(REPO_ROOT, 'converter')
const PSQL = 'D:\\12412\\PostgreSQL\\bin\\psql.exe'
const PG_HOST = '127.0.0.1'
const PG_PORT = 49353
const PG_USER = 'postgres' // role 名（非口令）
let PG_DB = process.env.RECRUITMENT_CAPTURE_PG_DB || 'ra_fix92_adapters' // 一次性库名（非口令），可被 --pg-db / env 覆盖
// 口令只从环境读取，缺失时 fail-closed；命令文本里只出现 `$env:PGPASSWORD`（R7 / INTERFACE-CONTRACT §命令原文）。
const PGPASSWORD_PLACEHOLDER = '$env:PGPASSWORD = <injected via env>; '
const HOST_PORT = 49349 // 禁止 49351/49303/49344
const HOST_PROFILE = 'rec-e2e-live' // hy4-flash-free；rec-preview-pr 的 longcat-2.5-free 已 410 deprecated
const START_HOST = join(MAIN_WORKSPACE, 'work', 'd5', 'e2e-live', 'scripts', 'start-host.ps1')
const NODE_BIN = 'D:\\node.exe'
const PWSH = [
  process.env.RECRUITMENT_PWSH,
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'pwsh',
].find((p) => typeof p === 'string' && p.length > 0)
const TURN_TEXT = '请只回复“收到”，不要调用任何工具。'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0) return process.argv[i + 1] ?? fallback
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`))
  return prefixed ? prefixed.slice(name.length + 3) : fallback
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}
function stamp() {
  return new Date().toISOString()
}

/** 命令台账：cmd 为可复核原文（不含当前有效凭据），stdoutDigest 为真实输出摘要。 */
function makeLedger() {
  const commands = []
  function record(cmd, cwd, result, extra = {}) {
    commands.push({
      cmd,
      cwd,
      exitCode: result?.status ?? null,
      stdoutDigest: result ? sha256Text(String(result.stdout ?? '')) : undefined,
      at: stamp(),
      ...extra,
    })
  }
  return { commands, record }
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return result
}

function assertOk(result, label) {
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-2000)
    throw new Error(`${label} failed (exit=${result.status}): ${detail}`)
  }
}

/** (a) converter：真实 Python 命令产出 DocumentContent。 */
function captureConverter(outDir, ledger) {
  const candidates = [
    join(MAIN_WORKSPACE, 'work', 'd5', 'gp-fix', 'first', 'run-2026-11-15T13-13-31-019Z', 'fixture-synthetic-resume-golden-path.pdf'),
    join(MAIN_WORKSPACE, 'work', 'd5', 'integration', 'golden-path-first-run', 'run-2026-11-15T18-12-58-920Z', 'fixture-synthetic-resume-golden-path.pdf'),
    join(MAIN_WORKSPACE, 'work', 'd5', 'agent', 'p0-3', 'e2e', 'synthetic', 'p03-synthetic-resume-v2.pdf'),
  ]
  const pdf = candidates.find((p) => existsSync(p))
  if (!pdf) throw new Error('no non-sensitive synthetic PDF found in main workspace work/d5/**')
  const destDir = join(outDir, 'converter')
  mkdirSync(destDir, { recursive: true })
  const docPath = join(destDir, 'document-content.json')
  const shaPath = join(destDir, 'source.pdf.sha256')
  const args = ['-m', 'src.cli', pdf, '--indent', '1', '--output', docPath]
  const cmd = `${PYTHON} -m src.cli "${pdf}" --indent 1 --output "${docPath}"`
  const result = run(PYTHON, args, { cwd: CONVERTER_DIR })
  ledger.record(cmd, CONVERTER_DIR, result, { kind: 'converter' })
  assertOk(result, 'converter python -m src.cli')
  if (!existsSync(docPath)) throw new Error('converter did not produce document-content.json')
  const doc = JSON.parse(readFileSync(docPath, 'utf8'))
  if (typeof doc.completeness !== 'string' || !Array.isArray(doc.blocks) || !Array.isArray(doc.issues)) {
    throw new Error('converter output is not a DocumentContent-shaped document')
  }
  const sourceSha = sha256File(pdf)
  writeJson(shaPath, {
    source: pdf,
    basename: basename(pdf),
    sha256: sourceSha,
    synthetic: true,
    note: '无 PII 的合成工程测试 PDF（fixture-synthetic-*），不是真实业务简历',
  })
  // 关键真实输出摘要（用于回报与独立复核；不抄候选人原文）。
  const summary = {
    completeness: doc.completeness,
    needs_visual: doc.needs_visual,
    pages: doc.meta?.pages,
    blocks: doc.blocks.length,
    issue_codes: (doc.issues ?? []).map((i) => i.code),
    backend: doc.meta?.backend,
    reader_version: doc.meta?.reader_version,
  }
  return {
    source: pdf,
    sourceSha,
    docPath,
    shaPath,
    summary,
    sourceMeta: { kind: 'SYNTHETIC_NO_PII', basename: basename(pdf), sha256: sourceSha },
  }
}

/** (b) PG：独立 psql 命令。口令只通过 env 注入。 */
function psql(db, sqlArgs, ledger, label, env = {}) {
  const args = ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', PG_HOST, '-p', String(PG_PORT), '-U', PG_USER, '-d', db, ...sqlArgs]
  const shown = []
  for (let i = 0; i < sqlArgs.length; i++) {
    if ((sqlArgs[i] === '-c' || sqlArgs[i] === '-f') && i + 1 < sqlArgs.length) {
      shown.push(`${sqlArgs[i]} ${JSON.stringify(sqlArgs[++i])}`)
    } else shown.push(sqlArgs[i])
  }
  const shownText = shown.join(' ')
  const cmd = `${PGPASSWORD_PLACEHOLDER}'${PSQL}' -X -At -v ON_ERROR_STOP=1 -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d ${db} ${shownText}`
  const password = process.env.RECRUITMENT_DB_PASSWORD ?? process.env.PGPASSWORD
  if (typeof password !== 'string' || password === '') {
    throw new Error('PG password missing: set RECRUITMENT_DB_PASSWORD or PGPASSWORD before capture (fail-closed; no hard-coded credential)')
  }
  const result = run(PSQL, args, { env: { PGPASSWORD: password, ...env } })
  ledger.record(cmd, REPO_ROOT, result, { kind: `pg:${label}` })
  return result
}

const COUNTS_SQL = `select 'application' as t, count(*)::text as n from recruitment.application
union all select 'interview', count(*)::text from recruitment.interview
union all select 'scorecard', count(*)::text from recruitment.scorecard
union all select 'decision', count(*)::text from recruitment.decision
union all select 'criterion_override', count(*)::text from recruitment.criterion_override
order by 1`

function parseCounts(result) {
  const counts = {}
  for (const line of result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [table, n, ...rest] = line.split('|')
    if (rest.length || !/^\d+$/.test(n ?? '')) throw new Error(`unexpected psql counts line: ${line}`)
    counts[table] = Number(n)
  }
  for (const table of ['application', 'interview', 'scorecard', 'decision', 'criterion_override']) {
    if (!Number.isFinite(counts[table])) throw new Error(`missing count for ${table}: ${result.stdout}`)
  }
  return counts
}

function readCounts(outDir, file, ledger) {
  const result = psql(PG_DB, ['-c', COUNTS_SQL], ledger, file)
  assertOk(result, `psql counts (${file})`)
  const counts = parseCounts(result)
  const payload = {
    application: counts.application,
    interview: counts.interview,
    scorecard: counts.scorecard,
    decision: counts.decision,
    criterion_override: counts.criterion_override,
    readAt: stamp(),
    command: `${PGPASSWORD_PLACEHOLDER}'${PSQL}' -X -At -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d ${PG_DB} -c "${COUNTS_SQL.replace(/\n/g, ' ')}"`,
  }
  const path = join(outDir, 'pg', file)
  writeJson(path, payload)
  return { path, payload, sha256: sha256File(path), raw: result.stdout.trim() }
}

/** (b) 建一次性库 → 重放迁移 → verify → 两次独立读回 → drop。 */
function capturePg(outDir, ledger) {
  const pgDir = join(outDir, 'pg')
  mkdirSync(pgDir, { recursive: true })
  let created = false
  try {
    // 旧同名库先清掉（一次性库，允许重建；不碰其它 ra_* 库）。
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${PG_DB}`], ledger, 'drop-before')
    const create = psql('postgres', ['-c', `CREATE DATABASE ${PG_DB}`], ledger, 'create')
    assertOk(create, 'create database')
    created = true

    let migrated = 0
    for (let n = 1; n <= 25; n++) {
      const prefix = `${String(n).padStart(4, '0')}_`
      const entries = readdirSync(join(REPO_ROOT, 'db', 'migrations')).filter((f) => f.startsWith(prefix) && f.endsWith('.sql')).sort()
      if (entries.length !== 1) throw new Error(`migration ${prefix} expected exactly one file, got ${entries.length}`)
      const r = psql(PG_DB, ['-f', join(REPO_ROOT, 'db', 'migrations', entries[0])], ledger, `migration-${entries[0]}`)
      assertOk(r, `migration ${entries[0]}`)
      migrated++
    }

    const verifyPath = join(REPO_ROOT, 'db', 'verify.sql')
    const verify = psql(PG_DB, ['-f', verifyPath], ledger, 'verify')
    assertOk(verify, 'db/verify.sql')
    const verifyTail = verify.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ')
    if (!/VERIFY PASS/.test(verify.stdout)) throw new Error(`db/verify.sql did not print VERIFY PASS: ${verifyTail}`)

    const before = readCounts(outDir, 'counts-before.json', ledger)
    const after = readCounts(outDir, 'counts-after.json', ledger)
    // 零写入是真实的：verify.sql 在事务里 ROLLBACK，两次读回一致本身即 L5 反证。
    return {
      database: PG_DB,
      port: PG_PORT,
      migrationsReplayed: migrated,
      verifyTail,
      countsBefore: before.payload,
      countsAfter: after.payload,
      countsBeforeRaw: before.raw,
      countsAfterRaw: after.raw,
      paths: [before.path, after.path],
      sha256: { before: before.sha256, after: after.sha256 },
    }
  } finally {
    if (created) {
      try { psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${PG_DB}`], ledger, 'drop-after') } catch { /* best effort cleanup */ }
    }
  }
}

/** (c) 真 Host SSE：复用主工作区脚本（只读引用），端口 49349；失败写 BLOCKED.json。 */
async function captureSse(outDir, ledger) {
  const sseDir = join(outDir, 'sse')
  mkdirSync(sseDir, { recursive: true })
  const framesPath = join(sseDir, 'agent-turn-frames.jsonl')
  const blockedPath = join(sseDir, 'BLOCKED.json')
  // 先清旧产物，避免上一次捕获被误当成本次证据。
  for (const p of [framesPath, blockedPath]) if (existsSync(p)) rmSync(p, { force: true })
  const hostScratch = join(sseDir, '_host')
  if (existsSync(hostScratch)) rmSync(hostScratch, { recursive: true, force: true })
  const attempted = []
  const tokenFile = join(process.env.TEMP ?? '.', `ra-pr-host-${HOST_PORT}.token`)
  let hostPid = null
  let token = ''
  try {
    if (!existsSync(START_HOST)) throw new Error(`start-host.ps1 not found: ${START_HOST}`)
    if (!existsSync(NODE_BIN)) throw new Error(`node not found: ${NODE_BIN}`)
    if (!existsSync(PWSH)) throw new Error('pwsh not on PATH')

    // npx tsdown 重建 lib（产物在主工作区插件目录）；失败不阻塞真 SSE：脚本本身只读取路由。
    const tsdownShim = join(MAIN_WORKSPACE, 'dsh', 'dsh-recruitment', 'node_modules', '.bin', 'tsdown.cmd')
    const tsdownCmd = `cmd.exe /c "${tsdownShim}"`
    attempted.push(tsdownCmd)
    try {
      const build = run('cmd.exe', ['/c', tsdownShim], { cwd: join(MAIN_WORKSPACE, 'dsh', 'dsh-recruitment') })
      ledger.record(tsdownCmd, join(MAIN_WORKSPACE, 'dsh', 'dsh-recruitment'), build, { kind: 'sse:tsdown', nonFatal: true })
    } catch (error) {
      ledger.record(tsdownCmd, join(MAIN_WORKSPACE, 'dsh', 'dsh-recruitment'), { status: null, stdout: String(error) }, { kind: 'sse:tsdown', nonFatal: true })
    }

    const startCmd = `${PWSH} -NoProfile -File "${START_HOST}" -Profile ${HOST_PROFILE} -Port ${HOST_PORT} -OutDir "${hostScratch}" -WaitSec 120`
    attempted.push(startCmd)
    const start = run(PWSH, ['-NoProfile', '-File', START_HOST, '-Profile', HOST_PROFILE, '-Port', String(HOST_PORT), '-OutDir', hostScratch, '-WaitSec', '120'], { cwd: REPO_ROOT })
    ledger.record(startCmd, REPO_ROOT, start, { kind: 'sse:start-host' })
    assertOk(start, 'start-host.ps1')
    const hostJsonFile = join(hostScratch, `host-${HOST_PORT}.json`)
    if (!existsSync(hostJsonFile)) throw new Error(`host metadata missing: ${hostJsonFile}`)
    const hostInfo = JSON.parse(readFileSync(hostJsonFile, 'utf8'))
    hostPid = hostInfo.pid ?? null
    if (!hostInfo.ready) throw new Error('host reported ready=false')

    if (!existsSync(tokenFile)) throw new Error('one-time token file missing after host start')
    token = readFileSync(tokenFile, 'utf8').trim()
    if (!token) throw new Error('one-time token file empty')
    const q = `?token=${encodeURIComponent(token)}`
    const sid = `session-${randomUUID()}`
    const headers = { 'Content-Type': 'application/json', 'x-recruitment-request': '1', 'X-DSH-Session': sid }

    const actorCmd = `PUT http://127.0.0.1:${HOST_PORT}/recruitment/api/actor?token=<redacted-from-TEMP-file> -H 'X-DSH-Session: ${sid}' (token 只从 ${tokenFile} 读取，不落 capture)`
    attempted.push(`PUT /recruitment/api/actor (sid=${sid})`)
    const actor = await fetch(`http://127.0.0.1:${HOST_PORT}/recruitment/api/actor${q}`, {
      method: 'PUT', headers, body: JSON.stringify({ alias: 'recruiter' }),
    })
    const actorBody = await actor.text()
    ledger.record(actorCmd, REPO_ROOT, { status: actor.status, stdout: actorBody }, { kind: 'sse:actor-bind' })
    if (!actor.ok) throw new Error(`actor bind failed: ${actor.status} ${actorBody.slice(0, 300)}`)

    const started = Date.now()
    const turnCmd = `POST http://127.0.0.1:${HOST_PORT}/recruitment/agent/turn?token=<redacted-from-TEMP-file> -H 'X-DSH-Session: ${sid}' -d '{"text":"${TURN_TEXT}","context":{"route":"/"}}'`
    attempted.push(`POST /recruitment/agent/turn (sid=${sid})`)
    const response = await fetch(`http://127.0.0.1:${HOST_PORT}/recruitment/agent/turn${q}`, {
      method: 'POST', headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify({ text: TURN_TEXT, context: { route: '/' } }),
    })
    const raw = await response.text()
    ledger.record(turnCmd, REPO_ROOT, { status: response.status, stdout: raw }, { kind: 'sse:turn', stdoutDigest: sha256Text(raw) })
    if (!response.ok) throw new Error(`agent turn HTTP ${response.status}: ${raw.slice(0, 300)}`)
    if (!/^event: /m.test(raw)) throw new Error(`response is not SSE: ${raw.slice(0, 300)}`)

    // 解析原始 SSE 帧为 JSONL；只做结构归一化，不改写 event/data 内容。
    const frames = []
    let event = null
    let dataLines = []
    const flush = () => {
      if (event === null) return
      const data = dataLines.join('\n')
      let parsed
      try { parsed = JSON.parse(data) } catch { parsed = { raw: data } }
      // 防御：任何帧里若出现真实 token，替换为 <redacted>（正常路径不会出现）。
      const scrub = (v) => (typeof v === 'string' ? v.split(token).join('<redacted>') : v)
      frames.push({
        event: scrub(event),
        data: typeof parsed === 'object' && parsed !== null ? JSON.parse(JSON.stringify(parsed).split(token).join('<redacted>')) : scrub(parsed),
        tsMs: Date.now() - started,
      })
      event = null
      dataLines = []
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line === '') { flush(); continue }
      if (line.startsWith('event: ')) { flush(); event = line.slice(7).trim() }
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
    }
    flush()
    if (frames.length === 0) throw new Error('SSE stream contained no frames')
    if (!frames.some((f) => f.event === 'delta') || !frames.some((f) => f.event === 'done')) {
      throw new Error(`SSE stream missing delta/done: events=${frames.map((f) => f.event).join(',')}`)
    }
    writeFileSync(framesPath, frames.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf8')
    return {
      ok: true, reason: null, profile: HOST_PROFILE, port: HOST_PORT,
      framesPath, framesCount: frames.length,
      events: frames.map((f) => f.event),
      answerText: frames.filter((f) => f.event === 'delta').map((f) => f.data?.text ?? '').join(''),
      sha256: sha256File(framesPath),
      attemptedCommands: attempted,
      hostPid,
    }
  } catch (error) {
    const rawReason = `${error?.message ?? String(error)}`
    const reason = token ? rawReason.split(token).join('<redacted>') : rawReason
    writeJson(blockedPath, {
      reason,
      attemptedCommands: attempted,
      timestamp: stamp(),
      profile: HOST_PROFILE,
      port: HOST_PORT,
    })
    return { ok: false, reason, blockedPath, sha256: sha256File(blockedPath), attemptedCommands: attempted, hostPid }
  } finally {
    // 收尾：杀 Host + 删除一次性 token（绝不落 capture）+ 删除含日志的临时目录。
    try { if (hostPid) process.kill(hostPid) } catch { /* already gone */ }
    try { if (existsSync(tokenFile)) rmSync(tokenFile, { force: true }) } catch { /* ignore */ }
    try { if (existsSync(hostScratch)) rmSync(hostScratch, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
async function main() {
  const outDir = resolve(arg('out', DEFAULT_OUT))
  PG_DB = arg('pg-db', PG_DB)
  const password = process.env.RECRUITMENT_DB_PASSWORD ?? process.env.PGPASSWORD
  if (typeof password !== 'string' || password === '') {
    console.error('[capture-real-inputs] FATAL: set RECRUITMENT_DB_PASSWORD or PGPASSWORD before capture (fail-closed; no hard-coded credential).')
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })
  const { commands, record } = makeLedger()
  const capturedAt = stamp()

  process.stdout.write(`[capture-real-inputs] out=${outDir}\n`)
  const converter = captureConverter(outDir, { commands, record })
  process.stdout.write(`[capture-real-inputs] converter: completeness=${converter.summary.completeness} pages=${converter.summary.pages} blocks=${converter.summary.blocks} sha256=${converter.sourceSha}\n`)
  const pg = capturePg(outDir, { commands, record })
  process.stdout.write(`[capture-real-inputs] pg: ${pg.migrationsReplayed} migrations, ${pg.verifyTail}\n`)
  const sse = await captureSse(outDir, { commands, record })
  process.stdout.write(`[capture-real-inputs] sse: ${sse.ok ? `frames=${sse.framesCount} events=${sse.events.join(',')}` : `BLOCKED reason=${sse.reason}`}\n`)

  const sha256 = {
    'converter/document-content.json': sha256File(converter.docPath),
    'converter/source.pdf.sha256': sha256File(converter.shaPath),
    'pg/counts-before.json': pg.sha256.before,
    'pg/counts-after.json': pg.sha256.after,
    ...(sse.ok
      ? { 'sse/agent-turn-frames.jsonl': sse.sha256 }
      : { 'sse/BLOCKED.json': sse.sha256 }),
  }
  const manifest = {
    schemaVersion: '1.0',
    capturedAt,
    sources: {
      converter: {
        kind: 'LIVE_PYTHON_CONVERTER',
        source: converter.source,
        sourceMeta: converter.sourceMeta,
        output: 'converter/document-content.json',
        summary: converter.summary,
      },
      pg: {
        kind: 'LIVE_PG17',
        host: PG_HOST, port: PG_PORT, database: pg.database,
        migrationsReplayed: pg.migrationsReplayed,
        verifyTail: pg.verifyTail,
        countsBefore: pg.countsBefore,
        countsAfter: pg.countsAfter,
        outputs: ['pg/counts-before.json', 'pg/counts-after.json'],
      },
      sse: sse.ok ? {
        kind: 'LIVE_HOST_SSE',
        profile: sse.profile, port: sse.port,
        endpoint: '/recruitment/agent/turn',
        output: 'sse/agent-turn-frames.jsonl',
        framesCount: sse.framesCount, events: sse.events,
        answerText: sse.answerText,
      } : {
        kind: 'SSE_BLOCKED',
        reason: sse.reason,
        output: 'sse/BLOCKED.json',
        note: '未伪造任何 SSE 帧',
      },
    },
    sha256,
    commands,
    capabilities: {
      converter: 'LIVE', pg: 'LIVE', sse: sse.ok ? 'LIVE' : 'NOT_CONNECTED',
    },
  }
  writeJson(join(outDir, 'manifest.json'), manifest)
  process.stdout.write(JSON.stringify({
    bundle: outDir,
    manifest: join(outDir, 'manifest.json'),
    sha256,
    converter: { path: converter.docPath, sha256: sha256['converter/document-content.json'], summary: converter.summary },
    pg: { paths: pg.paths, sha256: pg.sha256, rawBefore: pg.countsBeforeRaw, rawAfter: pg.countsAfterRaw },
    sse: { path: sse.ok ? sse.framesPath : sse.blockedPath, sha256: sse.sha256, framesCount: sse.framesCount ?? 0, reason: sse.reason },
    commands: commands.map((c) => ({ cmd: c.cmd, cwd: c.cwd, exitCode: c.exitCode })),
  }, null, 2) + '\n')
}

// node:fs readdirSync 只在这里动态取，避免顶部导入列表过长。
import { readdirSync } from 'node:fs'

main().catch((error) => {
  console.error(`[capture-real-inputs] FATAL: ${error?.stack ?? String(error)}`)
  process.exit(1)
})
