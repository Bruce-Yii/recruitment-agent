// 序列化层单测（node --test 直接跑 .ts，靠 Node 的类型擦除）。
//
// 覆盖：id 连续编号 / 一行一块 / 换行转义 / 空块不丢 / 超长切分（中文 / 英文 / 无边界）/
//       sha256 / page+bbox+原件 sha256 / 确定性 / 代理对不被切开。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_BLOCK_CHARS,
  NEWLINE_ESCAPE,
  formatBlockLine,
  indexEntryById,
  serialize,
  sha256Hex,
  splitBlockText,
} from '../../src/structure/serialize.ts'
import {
  BASIC_BLOCKS,
  basicDocument,
  documentOf,
  longChineseText,
  longEnglishText,
} from './fixtures.ts'

/** 按码点切片（索引里的 piece_start/piece_end 是码点偏移）。 */
function cpSlice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('')
}

test('A1 id 从 1 开始连续编号，一块一行', () => {
  const doc = basicDocument()
  assert.equal(doc.lines.length, BASIC_BLOCKS.length)
  assert.equal(doc.blockIndex.entries.length, BASIC_BLOCKS.length)
  doc.blockIndex.entries.forEach((item, offset) => {
    assert.equal(item.id, offset + 1)
    assert.equal(item.block_no, offset + 1)
  })
  assert.deepEqual(
    doc.blockIndex.entries.map((item) => item.id),
    [1, 2, 3, 4, 5, 6],
  )
})

test('A2 行格式固定为 "#id | pN | text"', () => {
  const doc = basicDocument()
  assert.equal(doc.lines[0], '#1 | p1 | 张三')
  assert.equal(doc.lines[2], '#3 | p1 | 工作经历')
  assert.equal(doc.text.split('\n').length, BASIC_BLOCKS.length)
})

test('A3 块内换行转义成 ⏎，行内不再有换行', () => {
  const doc = basicDocument()
  assert.equal(
    doc.lines[1],
    `#2 | p1 | 电话：13800001234${NEWLINE_ESCAPE}邮箱：Zhang.San@Example.com`,
  )
  for (const line of doc.lines) assert.equal(line.includes('\n'), false)
  assert.equal(doc.stats.escaped_newlines, 1)
  assert.equal(formatBlockLine(7, 3, 'a\nb'), `#7 | p3 | a${NEWLINE_ESCAPE}b`)
})

test('A4 空块保留 id 并标 empty=true（不丢弃任何 block）', () => {
  const doc = basicDocument()
  const empty = doc.blockIndex.entries[5]
  assert.ok(empty)
  assert.equal(empty.empty, true)
  assert.equal(empty.chars, 0)
  assert.equal(empty.sha256, sha256Hex(''))
  assert.equal(doc.lines[5], '#6 | p2 | ')
  assert.equal(doc.stats.empty_blocks, 1)
  const blockNumbers = new Set(doc.blockIndex.entries.map((item) => item.block_no))
  assert.equal(blockNumbers.size, BASIC_BLOCKS.length, '每个原始 block 都必须至少出现一次')
})

test('A5 超长中文块按句子边界切分，片段拼接等于原文且每片 <= 500', () => {
  const text = longChineseText(12)
  assert.equal(text.length, 1200)
  const doc = documentOf([text])
  assert.equal(doc.stats.split_blocks, 1)
  const pieces = doc.blockIndex.entries
  assert.ok(pieces.length >= 3, `应当切成 >=3 段，实际 ${pieces.length}`)

  const rebuilt = pieces.map((item) => cpSlice(text, item.piece_start, item.piece_end)).join('')
  assert.equal(rebuilt, text, '切分不得丢字 / 补字')

  const codePoints = Array.from(text)
  for (const item of pieces) {
    assert.ok(item.chars <= MAX_BLOCK_CHARS, `片段 ${item.id} 超过 500 字：${item.chars}`)
    assert.equal(item.parent_id, pieces[0]?.id, '同一块的 parent_id 必须相同')
    assert.equal(item.piece_count, pieces.length)
    assert.equal(item.sha256, sha256Hex(cpSlice(text, item.piece_start, item.piece_end)))
  }
  pieces.slice(0, -1).forEach((item, index) => {
    assert.equal(item.piece_index, index)
    assert.equal(codePoints[item.piece_end - 1], '。', `片段 ${item.id} 没有切在句号后面`)
  })
  assert.equal(pieces[0]?.piece_index, 0)
  assert.equal(pieces[0]?.piece_start, 0)
  assert.equal(pieces[pieces.length - 1]?.piece_end, codePoints.length)
})

test('A6 超长英文块在 ". " 句末切分（不切开 3.5 这种小数）', () => {
  const text = longEnglishText(8)
  const doc = documentOf([text])
  const pieces = doc.blockIndex.entries
  assert.ok(pieces.length >= 2)
  for (const item of pieces) assert.ok(item.chars <= MAX_BLOCK_CHARS)
  pieces.slice(0, -1).forEach((item) => {
    assert.equal(text[item.piece_end - 1], '.', `片段 ${item.id} 没有切在英文句号后面`)
    assert.equal(/\s/.test(text[item.piece_end] ?? ''), true)
  })
  assert.equal(
    pieces.map((item) => cpSlice(text, item.piece_start, item.piece_end)).join(''),
    text,
  )
})

test('A7 没有任何句子边界时硬切在 500，仍然不丢字', () => {
  const text = 'あ'.repeat(1000)
  const pieces = splitBlockText(text)
  assert.equal(pieces.length, 2)
  assert.equal(pieces[0]?.text.length, MAX_BLOCK_CHARS)
  assert.equal(pieces[1]?.text.length, 500)
  assert.equal(pieces.map((piece) => piece.text).join(''), text)
})

test('A8 sha256 与已知向量一致（abc / 空串）', () => {
  const doc = documentOf(['abc'])
  assert.equal(
    doc.blockIndex.entries[0]?.sha256,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('A9 block_index 记录 page / bbox / 原件 sha256', () => {
  const doc = basicDocument()
  const first = doc.blockIndex.entries[0]
  assert.ok(first)
  assert.equal(first.page, 1)
  assert.deepEqual(first.bbox, [161.28, 45.59, 205.19, 73.93])
  assert.equal(first.source_sha256, 'f'.repeat(64))
  assert.equal(doc.blockIndex.source_sha256, 'f'.repeat(64))
  assert.equal(first.kind, 'heading')
  assert.equal(first.provenance, 'native_text')
  assert.ok(indexEntryById(doc.blockIndex, 1))
  assert.equal(indexEntryById(doc.blockIndex, 99), undefined)
})

test('A10 页号 / bbox 缺失时不编造：写 p? 并记 null', () => {
  const doc = serialize({ blocks: [{ kind: 'paragraph', text: '无坐标的一行' }] })
  assert.equal(doc.lines[0], '#1 | p? | 无坐标的一行')
  assert.equal(doc.blockIndex.entries[0]?.page, null)
  assert.equal(doc.blockIndex.entries[0]?.bbox, null)
  assert.equal(doc.blockIndex.entries[0]?.source_sha256, null)
  assert.equal(doc.blockIndex.entries[0]?.kind, 'paragraph')
  assert.equal(doc.blockIndex.entries[0]?.provenance, 'unknown')
})

test('A11 同一输入两次序列化结果完全相同（确定性）', () => {
  const doc = documentOf([longChineseText(12), '普通一行', ''])
  const again = documentOf([longChineseText(12), '普通一行', ''])
  assert.equal(doc.text, again.text)
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), JSON.parse(JSON.stringify(again)))
  assert.deepEqual(doc.stats, again.stats)
})

test('A12 代理对（emoji）按码点切分，不会产生半个字符', () => {
  const text = '😀'.repeat(600)
  const doc = documentOf([text])
  const pieces = doc.blockIndex.entries
  assert.equal(pieces.length, 2)
  assert.equal(pieces[0]?.chars, 500)
  assert.equal(pieces[1]?.chars, 100)

  const first = pieces[0]
  const second = pieces[1]
  assert.ok(first && second)
  const firstText = cpSlice(text, first.piece_start, first.piece_end)
  const secondText = cpSlice(text, second.piece_start, second.piece_end)
  assert.equal(firstText + secondText, text)
  assert.equal(Array.from(firstText).length, 500)
  assert.equal(/\uD83D$/.test(firstText), false, '片段不能以高代理项结尾')
  assert.equal(/^\uDE00/.test(secondText), false, '片段不能以低代理项开头')
  assert.equal(first.sha256, sha256Hex(firstText))
})

test('A13 空输入不产出任何行，统计全为 0', () => {
  const doc = serialize({ blocks: [] })
  assert.equal(doc.text, '')
  assert.equal(doc.lines.length, 0)
  assert.equal(doc.blockIndex.entries.length, 0)
  assert.equal(doc.stats.blocks, 0)
  assert.equal(doc.blockIndex.blocks, 0)
})

test('A14 短块一律不切分：parent_id=null、piece_count=1', () => {
  const doc = documentOf(['短句一。', '短句二。'])
  for (const item of doc.blockIndex.entries) {
    assert.equal(item.parent_id, null)
    assert.equal(item.piece_count, 1)
    assert.equal(item.piece_index, 0)
    assert.equal(item.piece_start, 0)
    assert.equal(item.chars, item.piece_end)
  }
  assert.equal(doc.stats.split_blocks, 0)
})
