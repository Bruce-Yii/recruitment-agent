/**
 * G9 / D-112：转换器配置的 `${ENV}` 展开 + fail-closed 机检。
 *
 * 背景：仓库 profile 以前写死机器绝对路径（`D:\Python3.12.9\python.exe`、`D:\12412\...`）。
 * D-112 要求「配置文件只留 `${ENV}` 引用 + 环境变量提供值，仓库 profile 零机器路径」。
 * 展开必须由插件自己在启动时做（DSH 的 profile 层只解释 `!!js` 表达式，不做 `${ENV}`
 * 字符串插值），所以这个契约的唯一实现点是 `src/tools/converter.ts::resolveConverterConfig`。
 *
 * 本文件锁定七件事（对应任务书 1–7）：
 *   1. 白名单字段（python_bin / converter_dir / allowed_roots）全部由 `${...}` 提供时能正确展开，
 *      展开值逐字等于环境变量值，并通过「绝对路径」校验；
 *   2. 一个字符串里多个引用（含分隔符变量拼接）能正确展开；
 *   3. 未定义 / 空白变量 → **逐条** issue（每个字段×每个变量一条）、点名字段与变量名、
 *      resolved=null；issue 里不得出现环境变量的**值**；
 *   4. 非白名单字段不展开：`timeout_ms` 给 `${X}` 也走既有数值逻辑（默认 180000），
 *      且 env 缺 X 不产生 issue；普通 `$`（不是 `${}` 形态）不视为引用；
 *   5. 非法 `${...}` 形态（`${}` / `${1ABC}` / `${NAME` 未闭合）→ issue + resolved=null；
 *   6. 无 `${}` 的普通绝对路径行为与改动前一致（回归守卫，含既有错误串不变）；
 *   7. 不传 env 时默认 `process.env`（既有调用方 src/index.ts 行为兼容）。
 *
 * 平台无关：绝对路径用 `resolve('/')` 作根构造（Windows 得到 `C:\...`，POSIX 得到 `/...`），
 * **不要求文件真实存在**（本契约只做字符串/绝对路径校验，不 stat）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute, join, resolve, sep } from 'node:path'

import {
  DEFAULT_TIMEOUT_MS,
  expandEnvReferences,
  resolveConverterConfig,
  type ConverterConfig,
} from '../../src/tools/converter.ts'

/** 平台无关的绝对根：Windows = `<盘符>:\recruitment-env-fixture`，POSIX = `/recruitment-env-fixture`。 */
const ROOT = join(resolve('/'), 'recruitment-env-fixture')
const PYTHON = join(ROOT, 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const CONVERTER = join(ROOT, 'converter')
const RESUME_POOL = join(ROOT, 'resume-talent-pool')
const ORCHESTRATION = join(ROOT, 'orchestration')

/** 与 Owner 片段（work/verify-2026-11-15-g7g9/wiring/profile-fragment.yml）同名的变量。 */
const ENV: Readonly<Record<string, string>> = {
  RECRUITMENT_PYTHON_BIN: PYTHON,
  RECRUITMENT_CONVERTER_DIR: CONVERTER,
  RECRUITMENT_ALLOWED_ROOT_RESUME_POOL: RESUME_POOL,
  RECRUITMENT_ALLOWED_ROOT_ORCHESTRATION: ORCHESTRATION,
}

/** 只含 `${RECRUITMENT_*}` 引用的 converter 配置（= 目标 profile 的形状）。 */
const ENV_ONLY_CONFIG: ConverterConfig = {
  python_bin: '${RECRUITMENT_PYTHON_BIN}',
  converter_dir: '${RECRUITMENT_CONVERTER_DIR}',
  allowed_roots: [
    '${RECRUITMENT_ALLOWED_ROOT_RESUME_POOL}',
    '${RECRUITMENT_ALLOWED_ROOT_ORCHESTRATION}',
  ],
}

/** 一条 issue 里必须同时点名字段与变量名。 */
function hasIssue(issues: readonly string[], field: string, variable: string): boolean {
  return issues.some((issue) => issue.includes(field) && issue.includes(variable))
}

// ---------------------------------------------------------------------------
// 1. 展开成功（白名单三个字段全部来自 ${...}）
// ---------------------------------------------------------------------------

test('白名单字段全部来自 ${...}：展开值逐字等于 env 值，且通过绝对路径校验', () => {
  const { resolved, issues } = resolveConverterConfig(ENV_ONLY_CONFIG, ENV)
  assert.deepEqual(issues, [], `不应有 issue：${issues.join('; ')}`)
  assert.ok(resolved !== null, '合法引用必须解析成功（resolved 非空）')
  assert.equal(resolved.python_bin, PYTHON)
  assert.equal(resolved.converter_dir, CONVERTER)
  assert.deepEqual(resolved.allowed_roots, [RESUME_POOL, ORCHESTRATION])
  // 展开后仍要过既有校验：每个路径都必须是绝对的。
  assert.equal(isAbsolute(resolved.python_bin), true)
  assert.equal(isAbsolute(resolved.converter_dir), true)
  for (const root of resolved.allowed_roots) assert.equal(isAbsolute(root), true)
  // timeout_ms 没配 → 既有默认值（没有被 env 展开逻辑碰过）。
  assert.equal(resolved.timeout_ms, DEFAULT_TIMEOUT_MS)
})

// ---------------------------------------------------------------------------
// 2. 一个字符串里多个引用
// ---------------------------------------------------------------------------

test('多引用混合字符串：${ROOT}${SEP}converter 展开为单个绝对路径', () => {
  const config: ConverterConfig = {
    python_bin: '${RECRUITMENT_PYTHON_BIN}',
    converter_dir: '${RECRUITMENT_ROOT}${RECRUITMENT_SEP}converter',
    allowed_roots: ['${RECRUITMENT_ROOT}${RECRUITMENT_SEP}resume-talent-pool'],
  }
  const { resolved, issues } = resolveConverterConfig(config, {
    RECRUITMENT_PYTHON_BIN: PYTHON,
    RECRUITMENT_ROOT: ROOT,
    RECRUITMENT_SEP: sep,
  })
  assert.deepEqual(issues, [])
  assert.ok(resolved !== null)
  assert.equal(resolved.converter_dir, join(ROOT, 'converter'))
  assert.deepEqual(resolved.allowed_roots, [join(ROOT, 'resume-talent-pool')])

  // 纯函数视角：前后缀字面量保留、多个引用按出现顺序展开。
  assert.deepEqual(expandEnvReferences('pre-${A}-and-${B}-post', { A: 'x', B: 'y' }), {
    expanded: 'pre-x-and-y-post',
    missing: [],
    invalid: false,
  })
})

// ---------------------------------------------------------------------------
// 3. 未定义 / 空白变量：逐条 issue、fail-closed、不泄漏值
// ---------------------------------------------------------------------------

test('未定义/空白变量：逐条 issue（字段×变量）、resolved=null、点名字段、不回显 env 值', () => {
  const secretDir = join(ROOT, 's3cr3t-value-must-not-leak')
  const { resolved, issues } = resolveConverterConfig(
    {
      // 已展开部分带 secret 值，另一段是未定义变量：issue 只能点名变量，不能回显 secret。
      python_bin: '${RECRUITMENT_TEST_SECRET_DIR}${RECRUITMENT_TEST_UNDEFINED_PYTHON}',
      converter_dir: '${RECRUITMENT_TEST_BLANK_DIR}',
      allowed_roots: [
        '${RECRUITMENT_TEST_UNDEFINED_ROOT_A}',
        '${RECRUITMENT_TEST_UNDEFINED_ROOT_B}',
      ],
    },
    {
      RECRUITMENT_TEST_SECRET_DIR: secretDir,
      RECRUITMENT_TEST_BLANK_DIR: '   ', // 空白 = 未定义（空值不是路径）
    },
  )
  assert.equal(resolved, null, '有未定义变量必须 fail-closed')
  // 每个字段 × 每个未定义变量一条；不额外堆 "is required" 噪声。
  assert.equal(issues.length, 4, `issue 条数应为 4（python/ dir/ root[0]/ root[1]），实际：${issues.join(' | ')}`)
  assert.ok(hasIssue(issues, 'config.python_bin', '${RECRUITMENT_TEST_UNDEFINED_PYTHON}'))
  assert.ok(hasIssue(issues, 'config.converter_dir', '${RECRUITMENT_TEST_BLANK_DIR}'))
  assert.ok(hasIssue(issues, 'config.allowed_roots[0]', '${RECRUITMENT_TEST_UNDEFINED_ROOT_A}'))
  assert.ok(hasIssue(issues, 'config.allowed_roots[1]', '${RECRUITMENT_TEST_UNDEFINED_ROOT_B}'))
  for (const issue of issues) {
    assert.match(issue, /refusing to guess a default/, `issue 必须说明 fail-closed：${issue}`)
  }
  // R7：issue 里不得出现环境变量的值（尤其是已定义的 secret 路径）。
  const serialized = JSON.stringify(issues)
  assert.equal(serialized.includes(secretDir), false, 'issue 不得回显环境变量值')
  assert.equal(serialized.includes('s3cr3t-value-must-not-leak'), false)
})

test('未定义变量导致字段缺失时，不重复追加上一条 "is required"', () => {
  const { issues } = resolveConverterConfig(ENV_ONLY_CONFIG, {})
  // 三个字段各 1 条（roots 两项各 1 条）→ 4 条，且都不是 "is required"。
  assert.equal(issues.length, 4, issues.join(' | '))
  assert.equal(issues.some((issue) => /is required$/.test(issue)), false, issues.join(' | '))
  assert.equal(issues.some((issue) => /must list at least one readable root$/.test(issue)), false)
})

// ---------------------------------------------------------------------------
// 4. 非白名单字段不展开
// ---------------------------------------------------------------------------

test('timeout_ms 不是白名单：字符串 ${X} 走既有数值逻辑（默认 180000），缺 X 不产生 issue', () => {
  const { resolved, issues } = resolveConverterConfig(
    {
      ...ENV_ONLY_CONFIG,
      // 运行时配置解析器不做类型校验（YAML 可能给字符串）；这里模拟这一现实形状。
      timeout_ms: '${RECRUITMENT_TEST_TIMEOUT}' as unknown as number,
    },
    ENV, // 故意不含 RECRUITMENT_TEST_TIMEOUT
  )
  assert.deepEqual(issues, [], '非白名单字段不展开，缺变量也不得产生 issue')
  assert.ok(resolved !== null)
  assert.equal(resolved.timeout_ms, DEFAULT_TIMEOUT_MS)
})

test('普通 $ 不是引用：$HOME / 路径里的 $ 按字面保留', () => {
  const literalRoot = join(ROOT, '$prices')
  assert.deepEqual(expandEnvReferences('$HOME/${RECRUITMENT_TEST_MISSING}', { HOME: 'C:\\Users\\x' }), {
    expanded: '$HOME/',
    missing: ['RECRUITMENT_TEST_MISSING'],
    invalid: false,
  })
  const { resolved, issues } = resolveConverterConfig(
    {
      python_bin: PYTHON,
      converter_dir: CONVERTER,
      allowed_roots: [literalRoot],
    },
    {},
  )
  assert.deepEqual(issues, [])
  assert.ok(resolved !== null)
  assert.deepEqual(resolved.allowed_roots, [literalRoot])
})

test('单遍展开、不递归：环境变量的值里出现 ${...} 时按字面保留（不让 env 变成二次展开入口）', () => {
  assert.deepEqual(expandEnvReferences('${A}', { A: '${B}', B: 'evil' }), {
    expanded: '${B}',
    missing: [],
    invalid: false,
  })
})

// ---------------------------------------------------------------------------
// 5. 非法 ${...} 形态 → issue + resolved=null
// ---------------------------------------------------------------------------

test('非法引用形态（${} / ${1ABC} / ${NAME 未闭合）→ 清晰 issue + resolved=null', () => {
  for (const malformed of ['${}', '${1ABC}', '${NAME']) {
    const { resolved, issues } = resolveConverterConfig(
      {
        python_bin: malformed,
        converter_dir: CONVERTER,
        allowed_roots: [RESUME_POOL],
      },
      ENV,
    )
    assert.equal(resolved, null, `非法引用必须 fail-closed：${malformed}`)
    assert.equal(issues.length, 1, `${malformed} 应只产生 1 条 issue，实际：${issues.join(' | ')}`)
    assert.ok(issues[0]?.includes('config.python_bin'), `issue 必须点名字段：${issues[0]}`)
    assert.match(issues[0] ?? '', /malformed .*reference/)
  }
})

test('非法引用出现在 allowed_roots 的某一项时逐项点名，且不误伤其它项', () => {
  const { resolved, issues } = resolveConverterConfig(
    {
      python_bin: PYTHON,
      converter_dir: CONVERTER,
      allowed_roots: [RESUME_POOL, '${1BAD}'],
    },
    ENV,
  )
  assert.equal(resolved, null)
  assert.equal(issues.length, 1)
  assert.ok(issues[0]?.includes('config.allowed_roots[1]'), issues[0])
})

// ---------------------------------------------------------------------------
// 6. 回归守卫：无 ${} 的普通绝对路径行为与改动前一致
// ---------------------------------------------------------------------------

test('回归守卫：普通绝对路径 + 显式 timeout_ms 完全按原逻辑解析', () => {
  const { resolved, issues } = resolveConverterConfig(
    {
      python_bin: `  ${PYTHON}  `, // 既有逻辑是 trim 后使用
      converter_dir: CONVERTER,
      allowed_roots: [RESUME_POOL, ' '], // 空白的 root 项既有逻辑是丢弃
      timeout_ms: 123_456,
    },
    {},
  )
  assert.deepEqual(issues, [])
  assert.ok(resolved !== null)
  assert.equal(resolved.python_bin, PYTHON)
  assert.equal(resolved.converter_dir, CONVERTER)
  assert.deepEqual(resolved.allowed_roots, [RESUME_POOL])
  assert.equal(resolved.timeout_ms, 123_456)
})

test('回归守卫：空配置的 issue 集合/顺序与改动前逐字一致', () => {
  const { resolved, issues } = resolveConverterConfig({}, {})
  assert.equal(resolved, null)
  assert.deepEqual(issues, [
    'config.python_bin is required',
    'config.converter_dir is required',
    'config.allowed_roots must list at least one readable root',
  ])
})

test('回归守卫：相对路径仍被拒绝（展开不能让"来自 env"的值绕过绝对路径校验）', () => {
  const { resolved, issues } = resolveConverterConfig(
    {
      python_bin: '${RECRUITMENT_RELATIVE_PYTHON}',
      converter_dir: CONVERTER,
      allowed_roots: [RESUME_POOL],
    },
    { RECRUITMENT_RELATIVE_PYTHON: process.platform === 'win32' ? 'python\\python.exe' : 'bin/python3' },
  )
  assert.equal(resolved, null)
  assert.deepEqual(issues, ['config.python_bin must be absolute'])
})

// ---------------------------------------------------------------------------
// 7. 默认 env = process.env（既有调用方 src/index.ts 不传 env）
// ---------------------------------------------------------------------------

test('不传 env 时默认读 process.env（既有调用方行为兼容）', () => {
  const key = 'RECRUITMENT_TEST_DEFAULT_ENV_PYTHON'
  const previous = process.env[key]
  process.env[key] = PYTHON
  try {
    const { resolved, issues } = resolveConverterConfig({
      python_bin: '${' + key + '}',
      converter_dir: CONVERTER,
      allowed_roots: [RESUME_POOL],
    })
    assert.deepEqual(issues, [])
    assert.ok(resolved !== null)
    assert.equal(resolved.python_bin, PYTHON)
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})
