// 真实数据验收脚本（不属于插件运行时；只在本地跑）。
//
// 做两件事，全部基于**真实转换器输出**，不 mock：
//   A. 用 converter/corpus/batch2-picked.json 里的 3 份 PDF 跑序列化，打印前 10 行 + 统计；
//   B. 用第一份的真实 block_index / 真实块文本，构造 6 个负向样本，逐个断言它被拦下
//      （前 5 个必须 accepted=false，第 6 个时间倒挂必须 accepted=true 但记 soft issue）。
//
// 用法（在 dsh/dsh-recruitment 下）：
//   node test/structure/run-acceptance.mjs              # 有缓存就用缓存
//   node test/structure/run-acceptance.mjs --live       # 强制重跑转换器（Python）
//
// 边界：本脚本会写 %TEMP% 下的缓存目录，**不写仓库**；不联网；不调用模型。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serialize } from '../../src/structure/serialize.ts'
import { validate } from '../../src/structure/validate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')
const PROJECT_ROOT = resolve(PLUGIN_DIR, '..', '..')
const DEFAULT_CONVERTER = join(PROJECT_ROOT, 'converter')
const DEFAULT_PICKED = join(DEFAULT_CONVERTER, 'corpus', 'batch2-picked.json')
const DEFAULT_PYTHON = 'D:/Python3.12.9/python.exe'
// 0,22,43 = resume.pdf / 高涵-AI产品经理 / KEC CVPR（第 3 份含 49 个 >500 字的块，用来验切分）
const DEFAULT_PICKS = [0, 22, 43]

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const LIVE = flag('--live')
const CONVERTER = option('--conv', DEFAULT_CONVERTER)
const PICKED = option('--picked', DEFAULT_PICKED)
const PYTHON = option('--python', DEFAULT_PYTHON)
const CACHE = option('--cache', join(tmpdir(), 'structure-accept'))
const PICKS = option('--picks', DEFAULT_PICKS.join(','))
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value >= 0)

const failures = []
let passed = 0
let notApplicable = 0
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`[PASS] ${label}`)
  } else {
    failures.push(label)
    console.log(`[FAIL] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
function skipCheck(label) {
  notApplicable += 1
  console.log(`[N/A]  ${label}`)
}

/** 跑一次转换器（或读缓存），返回解析后的 JSON。 */
function loadConverterOutput(pick) {
  const sha = String(pick.Sha).toLowerCase()
  const cachePath = join(CACHE, `batch2-${sha.slice(0, 12)}.json`)
  if (!LIVE && existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8'))
  mkdirSync(CACHE, { recursive: true })
  execFileSync(
    PYTHON,
    ['-m', 'src.cli', pick.Path, '--no-isolation', '--output', cachePath, '--timeout', '50'],
    { cwd: CONVERTER, stdio: 'pipe', timeout: 180_000 },
  )
  if (!existsSync(cachePath)) throw new Error(`converter produced no output for ${pick.Path}`)
  return JSON.parse(readFileSync(cachePath, 'utf8'))
}

/** 某个 id 对应的原文（片段按码点偏移切片）。 */
function textOfEntry(entry, sourceBlocks) {
  if (entry === undefined) return ''
  const raw = typeof sourceBlocks[entry.block_no - 1]?.text === 'string'
    ? sourceBlocks[entry.block_no - 1].text
    : ''
  if (entry.piece_count > 1) {
    return Array.from(raw).slice(entry.piece_start, entry.piece_end).join('')
  }
  return raw
}

/** 找到第一个包含 value 的 id。 */
function findBlockId(serialized, sourceBlocks, value) {
  for (const entry of serialized.blockIndex.entries) {
    if (textOfEntry(entry, sourceBlocks).includes(value)) return entry.id
  }
  return null
}

/** 从真实块文本里找一段 "YYYY.MM-YYYY.MM" 区间。 */
function findDateRange(serialized, sourceBlocks) {
  const pattern = /(\d{4}[.\-/]\d{1,2})\s*[-–—~至]\s*(\d{4}[.\-/]\d{1,2})/
  for (const entry of serialized.blockIndex.entries) {
    const text = textOfEntry(entry, sourceBlocks)
    const match = pattern.exec(text)
    if (match === null) continue
    const start = match[1]
    const end = match[2]
    const company = text.replace(match[0], '').replace(/\s+/g, ' ').trim()
    return { id: entry.id, text, start, end, company }
  }
  return null
}

/** 字段引用。 */
const field = (value, blockId, state = 'present', reason) => {
  const out = { state, value, block_id: blockId }
  if (reason !== undefined) out.reason = reason
  return out
}

/** 用真实转换器结果构造一份「结构上成立」的基线结果（只为验校验层，不声称抽取正确）。 */
function buildBaseline(serialized, converter, sourceBlocks) {
  const warnings = []
  const fields = converter.fields ?? {}
  const basicFields = {}
  const basicIds = []
  const used = new Set()

  for (const key of ['name', 'phone', 'email']) {
    const fieldValue = fields[key]
    if (fieldValue === undefined) {
      basicFields[key] = field(null, null, 'absent')
      continue
    }
    if (fieldValue.state !== 'present' || typeof fieldValue.value !== 'string' || fieldValue.value.trim() === '') {
      if (fieldValue.state === 'unreadable') {
        basicFields[key] = field(null, null, 'unreadable', 'converter reported unreadable')
      } else {
        basicFields[key] = field(null, null, 'absent')
      }
      continue
    }
    const id = findBlockId(serialized, sourceBlocks, fieldValue.value)
    if (id === null) {
      warnings.push(`${key} value ${JSON.stringify(fieldValue.value)} is not found in any block; declared absent`)
      basicFields[key] = field(null, null, 'absent')
      continue
    }
    // 同一个块可能同时承载电话与邮箱：分区里只能出现一次（D-31 §1）。
    if (!used.has(id)) {
      used.add(id)
      basicIds.push(id)
    }
    basicFields[key] = field(fieldValue.value, id)
  }

  // D-31：每个 block 必须**恰好**归入一个 section 的 block_ids。
  // 所以字段引用的块必须写进它所在 section 的 block_ids，不能只靠「被引用」。
  const sections = [{ label: 'basic', block_ids: basicIds, fields: basicFields }]
  const range = findDateRange(serialized, sourceBlocks)
  if (range !== null && !used.has(range.id)) {
    used.add(range.id)
    const rangeEntry = serialized.blockIndex.entries.find((item) => item.id === range.id)
    const companyOk = range.company !== ''
      && textOfEntry(rangeEntry, sourceBlocks).includes(range.company)
    sections.push({
      label: 'work',
      block_ids: [range.id],
      entries: [
        {
          block_ids: [range.id],
          fields: {
            company: companyOk ? field(range.company, range.id) : field(null, null, 'absent'),
            title: field(null, null, 'absent'),
            start: field(range.start, range.id),
            end: field(range.end, range.id),
          },
        },
      ],
    })
  } else if (range !== null) {
    warnings.push(`date range block #${range.id} is already used by a basic field; work section skipped`)
  }

  const rest = serialized.blockIndex.entries.map((item) => item.id).filter((id) => !used.has(id))
  sections.push({ label: 'other', block_ids: rest })
  return { result: { sections, ignored: [] }, warnings, range, rest }
}

console.log('=== 环境 ===')
console.log(`node        : ${process.version}`)
console.log(`converter   : ${CONVERTER}`)
console.log(`python      : ${PYTHON}`)
console.log(`picked      : ${PICKED}`)
console.log(`cache       : ${CACHE}`)
console.log(`mode        : ${LIVE ? 'live（重跑转换器）' : 'cache（有缓存读缓存）'}`)
console.log(`picks       : ${PICKS.join(', ')}`)

const picked = JSON.parse(readFileSync(PICKED, 'utf8'))
console.log('')

/** 每份 PDF 的序列化结果。 */
const documents = []
for (let i = 0; i < PICKS.length; i += 1) {
  const pick = picked[PICKS[i]]
  if (pick === undefined) {
    console.log(`[FAIL] picks[${PICKS[i]}] 不存在`)
    failures.push(`picks[${PICKS[i]}]`)
    continue
  }
  const converter = loadConverterOutput(pick)
  const sourceBlocks = Array.isArray(converter.blocks) ? converter.blocks : []
  const serialized = serialize(converter)

  console.log(`=== A${i + 1} ${pick.Name} (sha ${String(pick.Sha).slice(0, 12)}…, ${converter.meta?.pages ?? '?'} 页) ===`)
  console.log(`blocks=${serialized.stats.blocks}  lines=${serialized.stats.lines}  split_blocks=${serialized.stats.split_blocks}`
    + `  empty_blocks=${serialized.stats.empty_blocks}  chars=${serialized.stats.chars}`)
  console.log('--- 输出前 10 行 ---')
  for (const line of serialized.lines.slice(0, 10)) console.log(line)
  console.log('---')

  const ids = serialized.blockIndex.entries.map((item) => item.id)
  check(
    `A${i + 1} id 从 1 连续编号且行数 == 索引数`,
    ids.length === serialized.lines.length && ids.every((id, offset) => id === offset + 1),
  )
  check(
    `A${i + 1} 一个 block 至少一行（不丢弃）`,
    new Set(serialized.blockIndex.entries.map((item) => item.block_no)).size === sourceBlocks.length,
  )
  check(
    `A${i + 1} 每个 id 的文本都不超过 500 字（切分上限生效）`,
    serialized.blockIndex.entries.every((item) => item.chars <= 500),
    `max=${Math.max(...serialized.blockIndex.entries.map((item) => item.chars))}`,
  )
  const longBlocks = sourceBlocks.filter((block) => typeof block.text === 'string' && Array.from(block.text).length > 500)
  if (longBlocks.length > 0) {
    check(`A${i + 1} ${longBlocks.length} 个 >500 字的块被切分`, serialized.stats.split_blocks >= longBlocks.length)
    const pieces = serialized.blockIndex.entries.filter((item) => item.piece_count > 1)
    const parents = new Set(pieces.map((item) => item.parent_id))
    check(`A${i + 1} 切分片段都带 parent_id`, pieces.length > 0 && [...parents].every((id) => id !== null))
    const rebuiltOk = [...parents].every((parentId) => {
      const group = pieces.filter((item) => item.parent_id === parentId)
      const raw = textOfEntry({ ...group[0], piece_count: 1, piece_start: 0, piece_end: 0 }, sourceBlocks)
      const joined = group
        .sort((a, b) => a.piece_index - b.piece_index)
        .map((item) => Array.from(raw).slice(item.piece_start, item.piece_end).join(''))
        .join('')
      return joined === raw
    })
    check(`A${i + 1} 切分片段拼接等于原文（不丢字）`, rebuiltOk)
  } else {
    console.log(`[N/A]  A${i + 1} 该文件没有 >500 字的块，切分断言不适用`)
    notApplicable += 1
  }
  console.log('')
  documents.push({ pick, converter, sourceBlocks, serialized })
}

// ---------------------------------------------------------------------------------------------
console.log('=== B 负向测试（真实 block_index + 真实块文本） ===')
console.log('说明：基线按 D-31 把每个块**恰好**放进一个 section（basic 的字段块 / 日期区间块 / 其余进 other），'
  + '只为让分区与覆盖率成立；它证明的是校验层在真实数据上跑得通，不声称这就是正确的抽取结果。')
const withPhone = documents.find((doc) => {
  const phone = doc.converter.fields?.phone
  return phone !== undefined && phone.state === 'present' && typeof phone.value === 'string'
})
const target = withPhone ?? documents[0]
if (target === undefined) throw new Error('no document could be loaded')

const baseline = buildBaseline(target.serialized, target.converter, target.sourceBlocks)
for (const warning of baseline.warnings) console.log(`[WARN] ${warning}`)

const baseResult = validate({
  result: baseline.result,
  blockIndex: target.serialized.blockIndex,
  blocks: target.sourceBlocks,
})
console.log(`基线（真实数据）：accepted=${baseResult.accepted}`
  + ` index_entries=${baseResult.stats.index_entries} covered=${baseResult.stats.covered}`
  + ` fields=${baseResult.stats.fields} hard=${baseResult.stats.hard} soft=${baseResult.stats.soft}`)
for (const item of baseResult.rejected) console.log(`   hard: ${item.code} @ ${item.path} — ${item.message}`)
check('B0 基线本身必须被接受（否则后面的负向没有意义）', baseResult.accepted, JSON.stringify(baseResult.rejected))

const clone = (value) => JSON.parse(JSON.stringify(value))
const codesOf = (result) => result.rejected.map((item) => item.code)
const basicIndex = baseline.result.sections.findIndex((item) => item.label === 'basic')
const workIndex = baseline.result.sections.findIndex((item) => item.label === 'work')
const otherIndex = baseline.result.sections.findIndex((item) => item.label === 'other')

// B1 值不是子串
{
  const broken = clone(baseline.result)
  broken.sections[basicIndex].fields.phone = field('00000000000', target.serialized.blockIndex.entries[0].id)
  const result = validate({ result: broken, blockIndex: target.serialized.blockIndex, blocks: target.sourceBlocks })
  check('B1 值不是子串 -> 拒绝（VALUE_NOT_IN_BLOCK）', codesOf(result).includes('VALUE_NOT_IN_BLOCK'),
    JSON.stringify(codesOf(result)))
}

// B2 引用不存在的 id
{
  const broken = clone(baseline.result)
  broken.sections[otherIndex].block_ids.push(99999)
  const result = validate({ result: broken, blockIndex: target.serialized.blockIndex, blocks: target.sourceBlocks })
  check('B2 引用不存在的 id -> 拒绝（UNKNOWN_BLOCK_ID）', codesOf(result).includes('UNKNOWN_BLOCK_ID'),
    JSON.stringify(codesOf(result)))
}

// B3 有 block 没被归类（覆盖率）
{
  const broken = clone(baseline.result)
  const dropped = broken.sections[otherIndex].block_ids.pop()
  const result = validate({ result: broken, blockIndex: target.serialized.blockIndex, blocks: target.sourceBlocks })
  check(`B3 有 block 没被归类（丢掉 #${dropped}）-> 拒绝（UNCOVERED_BLOCK）`,
    codesOf(result).includes('UNCOVERED_BLOCK'), JSON.stringify(codesOf(result)))
}

// B4 phone 格式非法（值仍是子串，隔离规则 6）
{
  const broken = clone(baseline.result)
  const phoneField = broken.sections[basicIndex].fields.phone
  const entry = target.serialized.blockIndex.entries.find((item) => item.id === phoneField.block_id)
  const raw = textOfEntry(entry, target.sourceBlocks)
  const at = raw.indexOf(phoneField.value)
  const prefixed = at > 0 ? raw.slice(at - 1, at + phoneField.value.length) : `${phoneField.value}x`
  broken.sections[basicIndex].fields.phone = field(prefixed, phoneField.block_id)
  const result = validate({ result: broken, blockIndex: target.serialized.blockIndex, blocks: target.sourceBlocks })
  console.log(`   注入的值 = ${JSON.stringify(prefixed)}（仍是原文子串）`)
  check('B4 phone 格式非法 -> 拒绝（PHONE_INVALID），且不误报 VALUE_NOT_IN_BLOCK',
    codesOf(result).includes('PHONE_INVALID') && !codesOf(result).includes('VALUE_NOT_IN_BLOCK'),
    JSON.stringify(codesOf(result)))
}

// B5 字段被省略
{
  const broken = clone(baseline.result)
  delete broken.sections[basicIndex].fields.email
  const result = validate({ result: broken, blockIndex: target.serialized.blockIndex, blocks: target.sourceBlocks })
  check('B5 省略 email 字段 -> 拒绝（MISSING_FIELD），不是 absent',
    codesOf(result).includes('MISSING_FIELD'), JSON.stringify(codesOf(result)))
}

// B6 时间倒挂（软：记 issue 不拒绝）
if (workIndex >= 0) {
  const broken = clone(baseline.result)
  const fields = broken.sections[workIndex].entries[0].fields
  const swapped = { start: fields.end.value, end: fields.start.value }
  fields.start = field(swapped.start, fields.start.block_id)
  fields.end = field(swapped.end, fields.end.block_id)
  const result = validate({ result: broken, blockIndex: target.serialized.blockIndex, blocks: target.sourceBlocks })
  const softCodes = result.issues.filter((item) => item.severity === 'soft').map((item) => item.code)
  console.log(`   倒挂后 start=${JSON.stringify(swapped.start)} end=${JSON.stringify(swapped.end)}`)
  check('B6 时间倒挂 -> 记 issue（WORK_PERIOD_INVERTED）但 accepted 仍为 true',
    result.accepted && softCodes.includes('WORK_PERIOD_INVERTED'),
    `accepted=${result.accepted} soft=${JSON.stringify(softCodes)} hard=${JSON.stringify(codesOf(result))}`)
} else {
  skipCheck('B6 该文件没有可用的工作经历区间')
}

console.log('')
console.log('=== 汇总 ===')
console.log(`checks: passed=${passed} failed=${failures.length} not_applicable=${notApplicable}`)
if (failures.length > 0) console.log(failures.join('\n'))
process.exitCode = failures.length === 0 ? 0 : 1
