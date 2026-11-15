// P0-3：worker 把任务书材料落进 session workspace 的纯单元测试（**不起 DSH 进程、不连库**）。
//
// 现场根因（CONTRACT §2.3）：真 Agent 在空 workspace + 空 cwd 里只能全盘搜索材料
// （attempt2/3 各 3 次 `Get-ChildItem -Recurse` → 180s WORKER_TIMEOUT）。`landMaterials`
// 在 spawn 之前把已校验材料复制进 `<workspaceDir>/materials`，任务书里的
// `material_workspace_ref` 直接可读。
//
// 守的纪律：
//   * 复制后**读回字节复算 sha256**；不一致 → 删除目标 + issue（绝不冒充成功）；
//   * 目标路径必须落在 `<ws>/materials` 内（文件名 sanitize + resolve 复核，`../` 逃不掉）；
//   * source 缺失 / 不是普通文件 → issue；没有 material_path 的材料跳过（任务书里已写 UNKNOWN）；
//   * `workspace_ref` 与 task-context 的 `workspaceRefForMaterial` 逐字一致（同一函数）。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'

import type { TaskContextMaterial } from '../../src/runtime/task-context.ts'
import { landMaterials, workspaceRefForMaterial } from '../../src/runtime/worker.ts'

/** 字节 sha256。 */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 真实临时 workspace（每次用例独立，跑完删干净）。 */
function makeTempDir(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `p03-land-${label}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 合成材料源文件（字节落在临时目录；不碰任何真实候选人资料）。 */
function writeSynthetic(sourceDir: string, fileName: string): { path: string; bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(`%PDF-1.4 synthetic material for P0-3 landing (${fileName})`, 'utf8')
  const filePath = join(sourceDir, fileName)
  writeFileSync(filePath, bytes)
  return { path: filePath, bytes, sha256: sha256Of(bytes) }
}

/** 构造一条任务书材料事实（只有带 material_path 的才会被落地）。 */
function makeMaterial(overrides: Partial<TaskContextMaterial> = {}): TaskContextMaterial {
  return {
    sha256: 'f'.repeat(64),
    file_name: 'gate1-probe-resume.pdf',
    byte_size: 1024,
    mime_type: 'application/pdf',
    storage_ref: 'content-addressed:sha256:ffff',
    ...overrides,
  }
}

/** 落地目录（resolve 后用于前缀断言）。 */
function materialsDirOf(workspaceDir: string): string {
  return resolve(join(workspaceDir, 'materials'))
}

describe('landMaterials (real temp workspace)', () => {
  test('copies a verified material into <workspaceDir>/materials with identical sha256 and workspace_ref', () => {
    const workspace = makeTempDir('hit-ws')
    const source = makeTempDir('hit-src')
    try {
      const asset = writeSynthetic(source.dir, 'gate1-probe-resume.pdf')
      const material = makeMaterial({
        sha256: asset.sha256,
        file_name: 'gate1-probe-resume.pdf',
        byte_size: asset.bytes.length,
        material_path: asset.path,
        workspace_ref: workspaceRefForMaterial('gate1-probe-resume.pdf', asset.sha256),
      })
      const result = landMaterials(workspace.dir, [material])

      assert.deepEqual(result.issues, [], `unexpected landing issues: ${result.issues.join('; ')}`)
      assert.equal(result.landed.length, 1)
      const landed = result.landed[0]
      assert.ok(landed !== undefined)
      assert.equal(landed.sha256, asset.sha256, 'landed sha256 must equal the source bytes hash')
      assert.equal(landed.workspace_ref, 'materials/gate1-probe-resume.pdf')
      assert.equal(landed.workspace_ref, material.workspace_ref, 'must reuse workspaceRefForMaterial verbatim')
      assert.equal(landed.path, join(materialsDirOf(workspace.dir), 'gate1-probe-resume.pdf'))
      assert.ok(
        landed.path.startsWith(`${materialsDirOf(workspace.dir)}${sep}`),
        `landed path escaped the materials directory: ${landed.path}`,
      )
      assert.equal(existsSync(landed.path), true)
      assert.deepEqual(readFileSync(landed.path), asset.bytes, 'copied bytes must be identical to the source')
    } finally {
      workspace.cleanup()
      source.cleanup()
    }
  })

  test('a sha256 mismatch is reported as an issue and the mismatching copy is deleted', () => {
    const workspace = makeTempDir('mismatch-ws')
    const source = makeTempDir('mismatch-src')
    try {
      const asset = writeSynthetic(source.dir, 'gate1-probe-resume.pdf')
      const material = makeMaterial({
        sha256: 'a'.repeat(64), // 故意与真实字节不符
        file_name: 'gate1-probe-resume.pdf',
        byte_size: asset.bytes.length,
        material_path: asset.path,
      })
      const result = landMaterials(workspace.dir, [material])

      assert.equal(result.landed.length, 0, 'a mismatching copy must never be reported as landed')
      assert.equal(result.issues.length, 1)
      assert.match(result.issues[0] ?? '', /^material_workspace_landing_failed:/)
      assert.match(result.issues[0] ?? '', /sha256 mismatch after copy/)
      assert.match(result.issues[0] ?? '', new RegExp(`expected a{64}`))
      assert.equal(
        existsSync(join(materialsDirOf(workspace.dir), 'gate1-probe-resume.pdf')),
        false,
        'the mismatching target file must be removed',
      )
    } finally {
      workspace.cleanup()
      source.cleanup()
    }
  })

  test('a missing source file is reported as an issue and nothing is landed', () => {
    const workspace = makeTempDir('missing-ws')
    const source = makeTempDir('missing-src')
    try {
      const material = makeMaterial({
        sha256: sha256Of(Buffer.from('something', 'utf8')),
        material_path: join(source.dir, 'does-not-exist.pdf'),
      })
      const result = landMaterials(workspace.dir, [material])

      assert.equal(result.landed.length, 0)
      assert.equal(result.issues.length, 1)
      assert.match(result.issues[0] ?? '', /material_workspace_landing_failed:/)
      assert.match(result.issues[0] ?? '', /missing or not a regular file/)
    } finally {
      workspace.cleanup()
      source.cleanup()
    }
  })

  test('a source that is a directory is reported as an issue', () => {
    const workspace = makeTempDir('dir-ws')
    const source = makeTempDir('dir-src')
    try {
      const nested = join(source.dir, 'a-directory.pdf')
      mkdirSync(nested)
      const material = makeMaterial({ material_path: nested })
      const result = landMaterials(workspace.dir, [material])
      assert.equal(result.landed.length, 0)
      assert.match(result.issues[0] ?? '', /missing or not a regular file/)
    } finally {
      workspace.cleanup()
      source.cleanup()
    }
  })

  test('a "../" file name is sanitized and cannot escape <workspaceDir>/materials', () => {
    const workspace = makeTempDir('escape-ws')
    const source = makeTempDir('escape-src')
    try {
      const asset = writeSynthetic(source.dir, 'gate1-probe-resume.pdf')
      const material = makeMaterial({
        sha256: asset.sha256,
        file_name: '../../../evil.pdf',
        byte_size: asset.bytes.length,
        material_path: asset.path,
      })
      const result = landMaterials(workspace.dir, [material])

      assert.deepEqual(result.issues, [])
      const landed = result.landed[0]
      assert.ok(landed !== undefined)
      assert.equal(landed.workspace_ref, 'materials/evil.pdf')
      assert.equal(landed.path, join(materialsDirOf(workspace.dir), 'evil.pdf'))
      assert.ok(landed.path.startsWith(`${materialsDirOf(workspace.dir)}${sep}`))
      assert.equal(existsSync(resolve(workspace.dir, '..', 'evil.pdf')), false, 'nothing may be written outside the workspace')
      assert.equal(existsSync(join(workspace.dir, 'evil.pdf')), false, 'nothing may be written outside materials/')
    } finally {
      workspace.cleanup()
      source.cleanup()
    }
  })

  test('materials without a resolved material_path are skipped (the brief already says MATERIAL UNKNOWN)', () => {
    const workspace = makeTempDir('skip-ws')
    try {
      const unresolved = makeMaterial({
        material_path: undefined,
        source: 'allowed_roots_lookup:NOT_FOUND_IN_ALLOWED_ROOTS;checked_roots=0',
      })
      const result = landMaterials(workspace.dir, [unresolved])
      assert.deepEqual(result.landed, [])
      assert.deepEqual(result.issues, [])
      assert.equal(existsSync(join(workspace.dir, 'materials')), false, 'no materials dir is created when nothing can be landed')
    } finally {
      workspace.cleanup()
    }
  })

  test('an empty material list is a no-op', () => {
    const workspace = makeTempDir('empty-ws')
    try {
      assert.deepEqual(landMaterials(workspace.dir, []), { landed: [], issues: [] })
      assert.equal(existsSync(join(workspace.dir, 'materials')), false)
    } finally {
      workspace.cleanup()
    }
  })

  test('an empty or relative workspaceDir is refused instead of writing into the process cwd', () => {
    const source = makeTempDir('relative-src')
    try {
      const asset = writeSynthetic(source.dir, 'gate1-probe-resume.pdf')
      const material = makeMaterial({
        sha256: asset.sha256,
        file_name: 'gate1-probe-resume.pdf',
        byte_size: asset.bytes.length,
        material_path: asset.path,
      })
      for (const workspaceDir of ['', '   ', 'relative/workspace', '..']) {
        const result = landMaterials(workspaceDir, [material])
        assert.deepEqual(result.landed, [], `nothing may be landed for workspaceDir=${JSON.stringify(workspaceDir)}`)
        assert.equal(result.issues.length, 1)
        assert.match(result.issues[0] ?? '', /^material_workspace_landing_failed:/)
        assert.match(result.issues[0] ?? '', /refusing to land materials/)
      }
      assert.equal(
        existsSync(join(process.cwd(), 'materials', 'gate1-probe-resume.pdf')),
        false,
        'must never copy material into <cwd>/materials',
      )
    } finally {
      source.cleanup()
    }
  })
})
