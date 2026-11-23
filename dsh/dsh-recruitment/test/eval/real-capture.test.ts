// Eval V2 真实输入 bundle 集成测试（Issue #92 P1-B / lane B2）：
// 独立复核 capture-real-inputs.mjs 落盘的证据，不 import 产品代码、不重跑采集器。
//  1) 结构与 sha256 一致性；
//  2) converter 输出确为真实 Python 命令产物（backend/version + 源文件 sha + 命令原文）；
//  3) PG counts 与独立 psql 读回一致（counts JSON / manifest / 命令原文交叉核对）；
//  4) SSE 缺失时必须有 BLOCKED.json，且绝不把假帧当真帧。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const DEFAULT_CAPTURE = join(REPO_ROOT, 'work', 'lane92-adapters', 'capture')
const CAPTURE = resolve(process.env.RECRUITMENT_CAPTURE_DIR ?? DEFAULT_CAPTURE)
const COUNT_TABLES = ['application', 'interview', 'scorecard', 'decision', 'criterion_override'] as const

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const paths = {
  manifest: join(CAPTURE, 'manifest.json'),
  doc: join(CAPTURE, 'converter', 'document-content.json'),
  pdfSha: join(CAPTURE, 'converter', 'source.pdf.sha256'),
  before: join(CAPTURE, 'pg', 'counts-before.json'),
  after: join(CAPTURE, 'pg', 'counts-after.json'),
  frames: join(CAPTURE, 'sse', 'agent-turn-frames.jsonl'),
  blocked: join(CAPTURE, 'sse', 'BLOCKED.json'),
}

describe('Eval V2 capture bundle（真实输入证据完整性）', () => {
  test('bundle 结构 + 每个证据文件的 sha256 与 manifest 一致', () => {
    assert.ok(existsSync(paths.manifest), `missing ${paths.manifest}`)
    const manifest = readJson(paths.manifest)
    assert.equal(manifest.schemaVersion, '1.0')
    assert.ok(manifest.capturedAt && !Number.isNaN(Date.parse(manifest.capturedAt)))
    assert.ok(manifest.sources && typeof manifest.sources === 'object')
    assert.ok(Array.isArray(manifest.commands) && manifest.commands.length > 0)
    assert.ok(manifest.sha256 && typeof manifest.sha256 === 'object')

    for (const required of [paths.doc, paths.pdfSha, paths.before, paths.after]) {
      assert.ok(existsSync(required), `missing ${required}`)
    }
    for (const [rel, expected] of Object.entries(manifest.sha256 as Record<string, string>)) {
      const file = join(CAPTURE, rel)
      assert.ok(existsSync(file), `manifest.sha256 references missing file: ${file}`)
      assert.equal(sha256(file), expected, `sha256 mismatch: ${rel}`)
      assert.match(expected, /^[0-9a-f]{64}$/, `bad sha256 shape: ${rel}`)
    }
    // 每条命令都必须有原文、cwd、exitCode；不得把口令/真 token 写进命令文本。
    for (const cmd of manifest.commands) {
      assert.equal(typeof cmd.cmd, 'string')
      assert.ok(cmd.cmd.length > 0)
      assert.equal(typeof cmd.cwd, 'string')
      // 外部命令 exit=0；HTTP 请求用状态码（200）记在 exitCode 位；nonFatal 步骤（如 tsdown 重建）允许非零但必须如实记录。
      assert.ok([0, 200, null].includes(cmd.exitCode) || cmd.nonFatal === true, `nonzero command: ${cmd.cmd}`)
      assert.doesNotMatch(cmd.cmd, /PGPASSWORD\s*=\s*postgres\b/)
      assert.doesNotMatch(cmd.cmd, /token=[A-Za-z0-9_-]{8,}/)
    }
  })

  test('converter 输出确为真实 Python converter 命令产物（非手填 payload）', () => {
    const manifest = readJson(paths.manifest)
    const doc = readJson(paths.doc)
    assert.equal(typeof doc.completeness, 'string')
    assert.equal(typeof doc.needs_visual, 'boolean')
    assert.ok(Array.isArray(doc.blocks) && doc.blocks.length > 0)
    assert.ok(Array.isArray(doc.issues))
    assert.ok(doc.meta && typeof doc.meta === 'object')
    assert.match(String(doc.meta.backend ?? ''), /pymupdf/i)
    assert.match(String(doc.meta.reader_version ?? ''), /^[\d.]+$/)
    // 输出里带真实源文件 sha 与页数/块数；与 manifest 的源声明交叉核对。
    assert.match(String(doc.meta.source_sha256 ?? ''), /^[0-9a-f]{64}$/)
    const pdfMeta = readJson(paths.pdfSha)
    assert.match(pdfMeta.sha256, /^[0-9a-f]{64}$/)
    assert.equal(doc.meta.source_sha256, pdfMeta.sha256)
    assert.equal(pdfMeta.synthetic, true, '合成材料必须标注 synthetic（R4 不冒充真实简历）')
    assert.equal(manifest.sources.converter.sourceMeta.sha256, pdfMeta.sha256)
    assert.equal(manifest.sha256['converter/document-content.json'], sha256(paths.doc))
    // 命令原文里必须真的调用 Python converter，并指向该 PDF。
    const converterCommands = manifest.commands.filter((c: any) => c.kind === 'converter')
    assert.ok(converterCommands.length >= 1)
    assert.match(converterCommands[0].cmd, /python(\.exe)?\s+-m\s+src\.cli\b/)
    assert.match(converterCommands[0].cmd, /--output\b/)
    assert.match(converterCommands[0].cmd, /fixture-synthetic|synthetic/i)
    assert.equal(converterCommands[0].exitCode, 0)
  })

  test('PG counts 与独立 psql 读回一致（before/after + manifest 三方交叉核对）', () => {
    const manifest = readJson(paths.manifest)
    const before = readJson(paths.before)
    const after = readJson(paths.after)
    for (const counts of [before, after]) {
      for (const table of COUNT_TABLES) {
        assert.equal(typeof counts[table], 'number', `counts missing numeric ${table}`)
        assert.ok(Number.isFinite(counts[table]) && counts[table] >= 0)
      }
      assert.ok(counts.readAt && !Number.isNaN(Date.parse(counts.readAt)))
      assert.match(counts.command, /psql\.exe/)
      assert.match(counts.command, /-h 127\.0\.0\.1 -p 49353/)
      assert.match(counts.command, /recruitment\.application/)
      assert.match(counts.command, /recruitment\.criterion_override/)
      assert.doesNotMatch(counts.command, /PGPASSWORD\s*=\s*postgres\b/)
    }
    for (const table of COUNT_TABLES) {
      assert.equal(before[table], manifest.sources.pg.countsBefore[table], `before ${table} disagrees with manifest`)
      assert.equal(after[table], manifest.sources.pg.countsAfter[table], `after ${table} disagrees with manifest`)
    }
    assert.equal(manifest.sources.pg.database, 'ra_fix92_adapters')
    assert.equal(manifest.sources.pg.port, 49353)
    assert.equal(manifest.sources.pg.migrationsReplayed, 25)
    assert.match(manifest.sources.pg.verifyTail, /VERIFY PASS/)
    // 命令台账里必须有建库、25 次迁移、verify、两次读回、drop。
    const kinds = manifest.commands.map((c: any) => String(c.kind ?? ''))
    assert.ok(kinds.includes('pg:create'), 'missing create command')
    assert.equal(kinds.filter((k: string) => k.startsWith('pg:migration-')).length, 25)
    assert.ok(kinds.includes('pg:verify'))
    assert.ok(kinds.includes('pg:counts-before.json'))
    assert.ok(kinds.includes('pg:counts-after.json'))
    assert.ok(kinds.includes('pg:drop-after'), '一次性库必须 drop')
    // verify.sql 在事务里 ROLLBACK：两次读回相等是真实零写入反证（L5）。
    assert.deepEqual(
      Object.fromEntries(COUNT_TABLES.map((t) => [t, before[t]])),
      Object.fromEntries(COUNT_TABLES.map((t) => [t, after[t]])),
      'verify.sql rolls back; countsBefore/countsAfter must agree',
    )
  })

  test('SSE：若有帧则为真 Host delta/done；若无帧必须有 BLOCKED.json 且不伪造', () => {
    const manifest = readJson(paths.manifest)
    const hasFrames = existsSync(paths.frames)
    const hasBlocked = existsSync(paths.blocked)
    assert.ok(hasFrames || hasBlocked, 'SSE 既无 frames 也无 BLOCKED.json')
    assert.ok(!(hasFrames && hasBlocked), 'SSE 不可同时存在 frames 与 BLOCKED.json')

    if (hasBlocked) {
      const blocked = readJson(paths.blocked)
      assert.equal(typeof blocked.reason, 'string')
      assert.ok(blocked.reason.length > 0)
      assert.ok(Array.isArray(blocked.attemptedCommands) && blocked.attemptedCommands.length > 0)
      assert.ok(blocked.timestamp && !Number.isNaN(Date.parse(blocked.timestamp)))
      assert.equal(manifest.capabilities.sse, 'NOT_CONNECTED')
      assert.equal(Object.keys(manifest.sha256).some((k) => k.startsWith('sse/')), true)
      // BLOCKED 时绝不允许存在帧文件（上一轮残留也算伪造风险）。
      assert.equal(hasFrames, false)
      return
    }

    const frames = readFileSync(paths.frames, 'utf8')
      .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
    assert.ok(frames.length >= 2, 'SSE 帧过少')
    for (const f of frames) {
      assert.equal(typeof f.event, 'string')
      assert.ok(f.event.length > 0)
      assert.ok(typeof f.tsMs === 'number' && f.tsMs >= 0)
    }
    assert.ok(frames.some((f) => f.event === 'delta'), 'missing delta frame')
    assert.ok(frames.some((f) => f.event === 'done'), 'missing done frame')
    const deltaText = frames.filter((f) => f.event === 'delta').map((f) => f.data?.text ?? '').join('')
    assert.ok(deltaText.length > 0, 'delta 帧无文本')
    assert.equal(manifest.capabilities.sse, 'LIVE')
    assert.equal(manifest.sources.sse.kind, 'LIVE_HOST_SSE')
    assert.equal(manifest.sources.sse.port, 49349)
    assert.equal(manifest.sha256['sse/agent-turn-frames.jsonl'], sha256(paths.frames))
    const turnCommands = manifest.commands.filter((c: any) => c.kind === 'sse:turn')
    assert.ok(turnCommands.length === 1 && turnCommands[0].exitCode === 200)
    assert.match(turnCommands[0].cmd, /agent\/turn\?token=<redacted/)
    // 帧里不出现一次性 token / 端口 49351。
    assert.doesNotMatch(frames.map((f) => JSON.stringify(f)).join('\n'), /token=[A-Za-z0-9_-]{8,}|49351/)
  })
})

/** 总控复验发现的伪造入口回归：CLI 必须校验 capture 完整性 + 来源类型（Issue #92 P1-B）。 */
describe('Eval V2 CLI capture 完整性负例（fail-closed）', () => {
  const CLI = join(HERE, 'run-eval-v2.mjs')
  const TMP_ROOT = join(REPO_ROOT, 'work', 'lane92-adapters', '_integrity-probe')
  const tempDirs: string[] = []

  function copyCapture(name: string): string {
    mkdirSync(TMP_ROOT, { recursive: true })
    const dir = join(TMP_ROOT, name)
    rmSync(dir, { recursive: true, force: true })
    cpSync(CAPTURE, dir, { recursive: true })
    tempDirs.push(dir)
    return dir
  }

  function runCli(captureDir: string, extraArgs: string[] = []) {
    return spawnSync(process.execPath, [
      CLI, '--mode=real', '--gate=ALL', `--capture=${captureDir}`,
      `--out=${join(captureDir, '_out')}`, ...extraArgs,
    ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env } })
  }

  test('a) 篡改证据文件（manifest 未同步 sha256）→ exit 2 且 stderr 含 integrity', () => {
    if (!existsSync(paths.manifest)) return // 无 bundle 时由上层 bundle 测试报错
    const dir = copyCapture('tamper')
    const docPath = join(dir, 'converter', 'document-content.json')
    const doc = readJson(docPath)
    doc.completeness = 'partial' // 手改字段，不动 manifest.sha256
    writeFileSync(docPath, JSON.stringify(doc, null, 2))
    const result = runCli(dir, ['--pg-db=ra_fix92_adapters'])
    assert.equal(result.status, 2, `expected fail-closed exit 2, got ${result.status}; stdout=${result.stdout}\nstderr=${result.stderr}`)
    assert.match(result.stderr, /capture integrity mismatch: converter\/document-content\.json/)
  })

  test('b) SSE 用 BLOCKED.json 替换（无帧）→ P6 NO_REAL_SOURCE、note 明说 blocked、不伪造帧', () => {
    if (!existsSync(paths.manifest)) return
    const dir = copyCapture('blocked')
    rmSync(join(dir, 'sse', 'agent-turn-frames.jsonl'), { force: true })
    const blocked = {
      reason: 'REGRESSION_PROBE: host unavailable (synthetic negative case, not real evidence)',
      attemptedCommands: ['pwsh start-host.ps1 -Port 49349'],
      timestamp: new Date().toISOString(),
    }
    writeFileSync(join(dir, 'sse', 'BLOCKED.json'), JSON.stringify(blocked, null, 2))
    const manifest = readJson(join(dir, 'manifest.json'))
    delete manifest.sha256['sse/agent-turn-frames.jsonl']
    manifest.sha256['sse/BLOCKED.json'] = sha256(join(dir, 'sse', 'BLOCKED.json'))
    manifest.sources.sse.kind = 'NOT_CONNECTED'
    if (manifest.capabilities) manifest.capabilities.sse = 'NOT_CONNECTED'
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    const result = runCli(dir, ['--pg-db=ra_fix92_adapters'])
    if (result.status === 2 && /real PG read failed|real PG connection is mandatory/.test(result.stderr)) {
      // 无可用隔离 PG 时 CLI 必须 fail-closed；绝不因此回退 contract 或伪造 P6 帧。
      assert.match(result.stderr, /FATAL/)
      return
    }
    // 0 = P1 判分通过；3 = 真实源存在但判分失败（两者都证明未伪造 P6/P6 帧）。
    assert.ok([0, 3].includes(result.status), `expected P1-only run (0 or all-failed 3), got ${result.status}; stderr=${result.stderr}`)
    const card = readJson(join(dir, '_out', 'evaluation-card.json'))
    assert.equal(card.executionMode, 'real_adapter')
    assert.deepEqual(card.coverage.realSourceCaseIds, ['P1-01'])
    assert.ok(card.coverage.noRealSourceCaseIds.includes('P6-01'))
    assert.ok(card.coverage.noRealSourceCaseIds.includes('P6-05'))
    assert.match(card.coverage.note, /SSE 未采集（BLOCKED:/)
    assert.match(result.stdout, /coverage: real=1 noRealSource=42/)
  })

  test('c) 清理探针目录', () => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  })
})
