// Eval V2 capture bundle 集成测试（Issue #92 P1-B / lane B2）：
// A) 默认用例自包含：在 os.tmpdir() 下构造最小合法 bundle，验证结构/sha256/来源 kind/CLI fail-closed。
//    不依赖 work/lane92-adapters/**，clean checkout / CI 可直接跑。
// B) 真实采集证据断言（ra_fix92_adapters / 49353 / 25 迁移 / VERIFY PASS / 真 converter 页数）
//    只在 RECRUITMENT_CAPTURE_DIR 指向真实 bundle 时运行；未设置时声明式 skip（不假绿）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'run-eval-v2.mjs')
const COUNT_TABLES = ['application', 'interview', 'scorecard', 'decision', 'criterion_override'] as const
const REAL_CAPTURE = process.env.RECRUITMENT_CAPTURE_DIR ? resolve(process.env.RECRUITMENT_CAPTURE_DIR) : undefined
const TMP_ROOT = join(tmpdir(), `ra-eval92-real-capture-${process.pid}`)
const cleanupDirs: string[] = []

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
function bundlePaths(root: string) {
  return {
    root,
    manifest: join(root, 'manifest.json'),
    doc: join(root, 'converter', 'document-content.json'),
    pdfSha: join(root, 'converter', 'source.pdf.sha256'),
    before: join(root, 'pg', 'counts-before.json'),
    after: join(root, 'pg', 'counts-after.json'),
    frames: join(root, 'sse', 'agent-turn-frames.jsonl'),
    blocked: join(root, 'sse', 'BLOCKED.json'),
  }
}

/** 构造最小合法 capture bundle（工程测试夹具，明确不是真实采集证据）。 */
function buildMinimalBundle(name: string, sseMode: 'frames' | 'blocked' = 'frames') {
  const root = join(TMP_ROOT, name)
  rmSync(root, { recursive: true, force: true })
  for (const sub of ['converter', 'pg', 'sse']) mkdirSync(join(root, sub), { recursive: true })
  cleanupDirs.push(root)
  const p = bundlePaths(root)

  const doc = {
    completeness: 'complete',
    needs_visual: false,
    page_count: 1,
    blocks: [{ page: 1, text: 'synthetic engineering fixture — no PII' }],
    issues: [],
    meta: { backend: 'pymupdf/0.0-test', reader_version: '0.0.0', source_sha256: 'a'.repeat(64) },
  }
  const counts = Object.fromEntries(COUNT_TABLES.map((t) => [t, 0])) as Record<string, number>
  const before = { ...counts, readAt: new Date().toISOString(), command: 'psql (minimal fixture, not real evidence)' }
  const after = { ...before, readAt: new Date().toISOString() }
  writeJson(p.doc, doc)
  writeJson(p.pdfSha, { sha256: 'a'.repeat(64), synthetic: true, note: 'MINIMAL_TEST_FIXTURE' })
  writeJson(p.before, before)
  writeJson(p.after, after)
  if (sseMode === 'frames') {
    writeFileSync(p.frames, [
      JSON.stringify({ event: 'delta', data: { text: '收到' }, tsMs: 1 }),
      JSON.stringify({ event: 'done', data: {}, tsMs: 2 }),
    ].join('\n'))
  } else {
    writeJson(p.blocked, {
      reason: 'MINIMAL_TEST_FIXTURE: SSE host unavailable',
      attemptedCommands: ['fixture-only'],
      timestamp: new Date().toISOString(),
    })
  }

  const sha: Record<string, string> = {
    'converter/document-content.json': sha256(p.doc),
    'converter/source.pdf.sha256': sha256(p.pdfSha),
    'pg/counts-before.json': sha256(p.before),
    'pg/counts-after.json': sha256(p.after),
  }
  if (sseMode === 'frames') sha['sse/agent-turn-frames.jsonl'] = sha256(p.frames)
  else sha['sse/BLOCKED.json'] = sha256(p.blocked)
  const manifest = {
    schemaVersion: '1.0',
    capturedAt: new Date().toISOString(),
    sources: {
      converter: { kind: 'LIVE_PYTHON_CONVERTER', source: 'MINIMAL_TEST_FIXTURE' },
      pg: { kind: 'LIVE_PG17', host: '127.0.0.1', port: 49353, database: 'MINIMAL_TEST_FIXTURE' },
      sse: { kind: sseMode === 'frames' ? 'LIVE_HOST_SSE' : 'NOT_CONNECTED', port: sseMode === 'frames' ? 49349 : undefined },
    },
    sha256: sha,
    commands: [{ cmd: 'MINIMAL_TEST_FIXTURE (not real evidence)', cwd: HERE, exitCode: 0, kind: 'fixture' }],
    capabilities: { converter: 'FIXTURE', pg: 'FIXTURE', sse: 'FIXTURE' },
  }
  writeJson(p.manifest, manifest)
  return p
}

describe('Eval V2 capture bundle（自包含最小夹具，clean-checkout 可跑）', () => {
  test('最小 bundle 结构 + sha256 + 来源 kind 自洽', () => {
    const p = buildMinimalBundle('minimal-ok')
    assert.ok(existsSync(p.manifest))
    const manifest = readJson(p.manifest)
    assert.equal(manifest.schemaVersion, '1.0')
    for (const [rel, expected] of Object.entries(manifest.sha256 as Record<string, string>)) {
      assert.ok(existsSync(join(p.root, rel)), `missing ${rel}`)
      assert.equal(sha256(join(p.root, rel)), expected, `sha256 mismatch: ${rel}`)
    }
    assert.equal(manifest.sources.converter.kind, 'LIVE_PYTHON_CONVERTER')
    assert.equal(manifest.sources.pg.kind, 'LIVE_PG17')
    assert.equal(manifest.sources.sse.kind, 'LIVE_HOST_SSE')
    assert.equal(readJson(p.doc).completeness, 'complete')
    for (const table of COUNT_TABLES) assert.equal(typeof readJson(p.before)[table], 'number')
    assert.ok(readFileSync(p.frames, 'utf8').includes('"event":"delta"'))
  })

  test('CLI fail-closed：篡改 bundle 文件（manifest 未同步）→ exit 2 且 stderr 含 integrity', () => {
    const p = buildMinimalBundle('minimal-tamper')
    const doc = readJson(p.doc)
    doc.completeness = 'partial'
    writeJson(p.doc, doc)
    const result = spawnSync(process.execPath, [
      CLI, '--mode=real', '--gate=ALL', `--capture=${p.root}`,
      `--out=${join(p.root, '_out')}`, '--pg-db=MINIMAL_TEST_DB',
    ], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(result.status, 2, `stderr=${result.stderr}`)
    assert.match(result.stderr, /capture integrity mismatch: converter\/document-content\.json/)
    assert.match(result.stderr, /FATAL: capture bundle incomplete/)
  })

  test('CLI fail-closed：manifest 来源 kind 不符 → exit 2', () => {
    const p = buildMinimalBundle('minimal-kind')
    const manifest = readJson(p.manifest)
    manifest.sources.pg.kind = 'FIXTURE_PG'
    writeJson(p.manifest, manifest)
    const result = spawnSync(process.execPath, [
      CLI, '--mode=real', '--gate=ALL', `--capture=${p.root}`,
      `--out=${join(p.root, '_out')}`, '--pg-db=MINIMAL_TEST_DB',
    ], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(result.status, 2, `stderr=${result.stderr}`)
    assert.match(result.stderr, /invalid capture source kind: pg/)
  })

  test('BLOCKED 最小 bundle：无帧也不伪造，kind=NOT_CONNECTED 结构自洽', () => {
    const p = buildMinimalBundle('minimal-blocked', 'blocked')
    const manifest = readJson(p.manifest)
    assert.equal(manifest.sources.sse.kind, 'NOT_CONNECTED')
    assert.equal(existsSync(p.frames), false)
    assert.equal(sha256(p.blocked), manifest.sha256['sse/BLOCKED.json'])
    assert.match(readJson(p.blocked).reason, /MINIMAL_TEST_FIXTURE/)
  })

  test('清理临时夹具目录', () => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true })
    rmSync(TMP_ROOT, { recursive: true, force: true })
  })
})

/** 真实采集证据断言：仅当 RECRUITMENT_CAPTURE_DIR 指向真实 bundle 时运行；否则声明式 skip。 */
const realTest = REAL_CAPTURE ? test : test.skip
describe('Eval V2 真实采集 bundle（env-gated，需要 RECRUITMENT_CAPTURE_DIR）', () => {
  const p = REAL_CAPTURE ? bundlePaths(REAL_CAPTURE) : undefined

  realTest('真实 bundle：结构 + sha256 与 manifest 一致', () => {
    assert.ok(p && existsSync(p.manifest), `missing ${p?.manifest}`)
    const manifest = readJson(p!.manifest)
    assert.equal(manifest.schemaVersion, '1.0')
    for (const [rel, expected] of Object.entries(manifest.sha256 as Record<string, string>)) {
      const file = join(p!.root, rel)
      assert.ok(existsSync(file), `manifest.sha256 references missing file: ${file}`)
      assert.equal(sha256(file), expected, `sha256 mismatch: ${rel}`)
    }
  })

  realTest('真实 converter 输出确为 Python converter 命令产物', () => {
    const doc = readJson(p!.doc)
    assert.match(String(doc.meta?.backend ?? ''), /pymupdf/i)
    assert.ok(Array.isArray(doc.blocks) && doc.blocks.length > 0)
    const pdfMeta = readJson(p!.pdfSha)
    assert.equal(doc.meta.source_sha256, pdfMeta.sha256)
    assert.equal(pdfMeta.synthetic, true)
  })

  realTest('真实 PG counts：49353 / 25 迁移 / VERIFY PASS / 独立 psql 读回', () => {
    const manifest = readJson(p!.manifest)
    const before = readJson(p!.before)
    const after = readJson(p!.after)
    for (const counts of [before, after]) {
      for (const table of COUNT_TABLES) assert.equal(typeof counts[table], 'number')
      assert.match(counts.command, /psql\.exe/)
      assert.match(counts.command, /-h 127\.0\.0\.1 -p 49353/)
      assert.doesNotMatch(counts.command, /PGPASSWORD\s*=\s*postgres\b/)
    }
    const expectedDb = process.env.RECRUITMENT_CAPTURE_PG_DB || process.env.RECRUITMENT_TEST_DB
    assert.equal(typeof manifest.sources.pg.database, 'string')
    assert.ok(manifest.sources.pg.database.length > 0, 'manifest.sources.pg.database must be non-empty')
    if (expectedDb) assert.equal(manifest.sources.pg.database, expectedDb, 'PG DB name must match env override')
    // counts 文件里的命令文本必须与 manifest 声明的库名一致（防手改）。
    assert.match(before.command, new RegExp(`-d\\s+${manifest.sources.pg.database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`))
    assert.equal(manifest.sources.pg.port, 49353)
    assert.equal(manifest.sources.pg.migrationsReplayed, 25)
    assert.match(manifest.sources.pg.verifyTail, /VERIFY PASS/)
    const kinds = manifest.commands.map((c: any) => String(c.kind ?? ''))
    assert.equal(kinds.filter((k: string) => k.startsWith('pg:migration-')).length, 25)
    assert.ok(kinds.includes('pg:verify'))
    assert.ok(kinds.includes('pg:drop-after'))
  })

  realTest('真实 SSE：帧为真 Host delta/done 或 BLOCKED.json 不伪造', () => {
    const manifest = readJson(p!.manifest)
    const hasFrames = existsSync(p!.frames)
    const hasBlocked = existsSync(p!.blocked)
    assert.ok(hasFrames || hasBlocked)
    assert.ok(!(hasFrames && hasBlocked))
    if (hasBlocked) {
      assert.match(readJson(p!.blocked).reason, /\S/)
      assert.equal(hasFrames, false)
      return
    }
    const frames = readFileSync(p!.frames, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    assert.ok(frames.some((f: any) => f.event === 'delta'))
    assert.ok(frames.some((f: any) => f.event === 'done'))
    assert.equal(manifest.sources.sse.kind, 'LIVE_HOST_SSE')
    assert.equal(manifest.sources.sse.port, 49349)
    assert.equal(manifest.sha256['sse/agent-turn-frames.jsonl'], sha256(p!.frames))
  })
})
