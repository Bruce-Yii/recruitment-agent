/**
 * 守卫：代码里的转换器默认超时必须与产品 profile 一致。
 *
 * 为什么需要这个测试：这个值曾经存在两处——代码默认 60_000、产品 profile 180_000。
 * 产品调成 180s 后代码默认没跟着改，于是**任何不读 profile 的调用方**（回归脚本、
 * 手工探针、新写的工具入口）都会用 60s 预算，把真实语料里最慢 127s 的文档误判成
 * `TIMEOUT`。D-99 台账里那个"2 份失败"中的 TIMEOUT 就是这么来的假失败。
 *
 * 这不是"改个常量"，是把双源变成单源 + 机检：以后谁改了一边忘了另一边，这个测试红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_TIMEOUT_MS } from '../../src/tools/converter.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** 产品 profile：`dsh/profile/recruitment/cordis.patch.yml`（相对本测试文件）。 */
const PROFILE_PATH = join(here, '..', '..', '..', 'profile', 'recruitment', 'cordis.patch.yml')

/** 从 profile 文本里取 `recruitment.converter.timeout_ms`。 */
function profileConverterTimeout(text: string): number | null {
  // 先定位 recruitment 插件那一块（insert 列表里的 `id: recruitment`），再在其后找
  // converter: 下的 timeout_ms——避免误取到别的插件的同名字段。
  const anchor = text.indexOf('id: recruitment')
  if (anchor < 0) return null
  const converterAt = text.indexOf('converter:', anchor)
  if (converterAt < 0) return null
  const match = /timeout_ms:\s*(\d+)/.exec(text.slice(converterAt))
  return match ? Number(match[1]) : null
}

test('产品 profile 里能取到 converter.timeout_ms', () => {
  const text = readFileSync(PROFILE_PATH, 'utf8')
  const timeout = profileConverterTimeout(text)
  assert.ok(timeout !== null, `profile 里没找到 recruitment.converter.timeout_ms：${PROFILE_PATH}`)
  assert.ok(Number.isFinite(timeout) && timeout > 0, 'profile 的 timeout_ms 必须是正数')
})

test('代码默认超时 == 产品 profile 的超时（双源分叉即失败）', () => {
  const text = readFileSync(PROFILE_PATH, 'utf8')
  const profileTimeout = profileConverterTimeout(text)
  assert.equal(
    DEFAULT_TIMEOUT_MS,
    profileTimeout,
    `DEFAULT_TIMEOUT_MS(${DEFAULT_TIMEOUT_MS}) 与产品 profile 的 converter.timeout_ms(${profileTimeout}) 不一致。` +
      '不读 profile 的调用方会拿到错误的超时预算——改一边必须同时改另一边。',
  )
})

test('默认超时留够 OCR 兜底的余量（不得低于 120s）', () => {
  // D-98 的整页 OCR 兜底让单份最慢可达 127s（高并发下实测）。低于 120s 必然重新引入
  // "慢文档被误判 TIMEOUT"的假失败。这条是下限守卫，不是重复上面的等值断言。
  assert.ok(
    DEFAULT_TIMEOUT_MS >= 120_000,
    `DEFAULT_TIMEOUT_MS(${DEFAULT_TIMEOUT_MS}) 低于 120s：OCR 兜底最慢可达 127s，会误判 TIMEOUT`,
  )
})
