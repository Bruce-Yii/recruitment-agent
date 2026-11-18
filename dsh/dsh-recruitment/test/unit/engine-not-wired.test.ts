/**
 * 防复发静态守卫：engine 层已退役（D-154，见 docs/17-decision-ledger.md）。
 *
 * 事实：真 Host 跑完整链后 engine_ticket / engine_effect / engine_outbox /
 * engine_trigger / engine_disposition 全部 0 行（无人写入）；其 drive() 不检查
 * tick loop 的 advisory lock，等于开了一条不受锁约束的派发路径（多实例下是假不变量）。
 * 处置：拆掉 src/index.ts 的装配，代码原样保留为"未启用模块"，engine_* 表保留但不写。
 *
 * 本测试不 import 任何产品代码，只读 src/index.ts 源码文本做静态断言：
 * 一旦有人把 engine 层重新接回运行入口（重新 import ./engine/ 或 start engineEffects），测试即红。
 * 若确需启用，必须先在 docs/17 立裁决，并复核 advisory-lock 不变量后再改本测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** 从 test/unit/ 到 src/ 的相对路径。 */
const INDEX_SOURCE = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')

const REWIRE_MESSAGE =
  'engine 层已退役，重新接线需先立裁决（D-154）；不要从 src/index.ts import ./engine/ 或 start engineEffects。'

test('src/index.ts 不含 ./engine/ 的 import（engine 层已退役，不得重新接线）', () => {
  assert.doesNotMatch(
    INDEX_SOURCE,
    /\.\/engine\//,
    REWIRE_MESSAGE,
  )
})

test('src/index.ts 不调用 engineEffects.start(（engine 层已退役，不得重新接线）', () => {
  assert.doesNotMatch(
    INDEX_SOURCE,
    /engineEffects\.start\(/,
    REWIRE_MESSAGE,
  )
})

test('src/index.ts 无 engineEffects 标识符残留（engine 层已退役，不得重新接线）', () => {
  assert.doesNotMatch(
    INDEX_SOURCE,
    /\bengineEffects\b/,
    REWIRE_MESSAGE,
  )
})
