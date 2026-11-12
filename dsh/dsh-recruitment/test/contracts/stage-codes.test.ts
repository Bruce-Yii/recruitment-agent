// 阶段码口径机械检查（防复发，不是形式）。
//
// 背景：本项目曾同时存在两套 12 阶段编号 —— 生命周期编号（数据库
// `recruitment.stage_catalog`，0002_seed.sql 种入）与老仓
// `work/handoff/15-architecture-hv.md` 的架构编号。契约文件当时照架构编号写成
// S7 身份解析 / S8 筛选 / S9 面试安排 / S10 面试与转写 / S11 评价与决策 /
// S12 Offer，而库里 S7=初筛、S8=面试规划与排期、S9=面试执行与材料获取、
// S10=综合评价与招聘决策、S11=Offer 与入职交接。D-22 已裁定：
// **阶段码唯一口径 = stage_catalog 的 S1–S12**（见 contracts/STAGE-CODES.md）。
//
// 为什么必须机检：`decision.stage_code` 在 0001_init.sql 里**只有正则、没有外键**
// （`ck_decision_stage_code`，0001:L1355），把评价决策写成 'S11'（Offer 阶段）
// 数据库一声不吭。`interview.stage_code` 已在 0006 补外键（fk_interview_stage_catalog），
// `decision.stage_code` 待 0007 —— 在那之前契约是唯一的拦截点。
//
// 跑法（Node 24，直接跑 .ts，无需构建）：
//   cd dsh/dsh-recruitment && node --test "test/contracts/*.test.ts"
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..', '..') // dsh/dsh-recruitment
const REPO = resolve(PKG, '..', '..') // 仓库根
const CONTRACTS = join(PKG, 'contracts')
const STAGE_CODES_DOC = join(CONTRACTS, 'STAGE-CODES.md')
const DECISION_RULES = join(CONTRACTS, 'evaluation', 'decision-rules.md')
const SEED = join(REPO, 'db', 'migrations', '0002_seed.sql')

/** 扫描面：contracts 下所有 .md（递归）+ 根层 .json。 */
function contractFiles(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(CONTRACTS, { withFileTypes: true })) {
    const p = join(CONTRACTS, entry.name)
    if (entry.isDirectory()) {
      for (const f of readdirSync(p, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith('.md')) out.push(join(p, f.name))
      }
    } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.md'))) {
      out.push(p)
    }
  }
  return out.sort()
}

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

function rel(file: string): string {
  return relative(CONTRACTS, file).replaceAll('\\', '/')
}

/** 与 `\bS\d+\b` 同义：S + 数字，且两侧都不是 [A-Za-z0-9_]（`NOT_S11` 不算阶段码）。 */
const STAGE_CODE = /\bS\d+\b/g

/** 按空行切段，保留行号（markdown 表格/代码块天然是同段）。 */
function paragraphs(text: string): { startLine: number; lines: { no: number; text: string }[] }[] {
  const groups: { startLine: number; lines: { no: number; text: string }[] }[] = []
  let cur: { no: number; text: string }[] = []
  text.split('\n').forEach((line, idx) => {
    if (line.trim() === '') {
      if (cur.length > 0) {
        groups.push({ startLine: cur[0].no, lines: cur })
        cur = []
      }
    } else {
      cur.push({ no: idx + 1, text: line })
    }
  })
  if (cur.length > 0) groups.push({ startLine: cur[0].no, lines: cur })
  return groups
}

test('T1 contracts 里所有 Sxx 字面量都落在 S1–S12', () => {
  const files = contractFiles()
  assert.ok(files.length >= 18, `contracts 文件数异常：${files.length}（应含 17 个 md + schema.json）`)

  const outOfRange: string[] = []
  let seen = 0
  for (const file of files) {
    const text = read(file)
    text.split('\n').forEach((line, idx) => {
      for (const m of line.matchAll(STAGE_CODE)) {
        seen++
        if (!/^S([1-9]|1[0-2])$/.test(m[0])) outOfRange.push(`${rel(file)}:${idx + 1}: ${m[0]}`)
      }
    })
  }

  assert.deepEqual(outOfRange, [], `存在 S1–S12 之外的阶段码字面量：\n${outOfRange.join('\n')}`)
  // 防空转：正则写错/文件读空时这条会先炸，而不是"0 个问题 = 通过"
  assert.ok(seen >= 100, `只扫到 ${seen} 个 Sxx 字面量，扫描面可能不对`)
})

test('T2 「评价/决策/面评/汇总」段落里 S11 只能是 Offer 语义', () => {
  const flags: string[] = []
  // STAGE-CODES.md 是唯一允许**引用旧编号**的文档（§2 成因 / §3 映射表），单独豁免。
  for (const file of contractFiles().filter((f) => f !== STAGE_CODES_DOC)) {
    for (const para of paragraphs(read(file))) {
      const body = para.lines.map((l) => l.text).join('\n')
      if (!/评价|决策|面评|汇总/.test(body) || !/\bS11\b/.test(body)) continue
      for (const line of para.lines) {
        if (!/\bS11\b/.test(line.text)) continue
        // 合法用法：S11 = Offer 与入职交接。必须同行带 Offer 语义标记。
        if (!/Offer|入职|HIRED|缓做|Deferred|不做/.test(line.text)) {
          flags.push(`${rel(file)}:${line.no}: ${line.text.trim()}`)
        }
      }
    }
  }
  assert.deepEqual(flags, [], `S11（Offer 阶段）被当成评价/决策阶段使用：\n${flags.join('\n')}`)
})

test('T3 「筛选/Screening」段落不得出现 S8', () => {
  const flags: string[] = []
  for (const file of contractFiles().filter((f) => f !== STAGE_CODES_DOC)) {
    for (const para of paragraphs(read(file))) {
      const body = para.lines.map((l) => l.text).join('\n')
      if (!/筛选|[Ss]creening/.test(body) || !/\bS8\b/.test(body)) continue
      // 例外：这一段同时在讲排期/面试本身（跨文件互引时会混排），S8 是正确用法。
      if (/面试|排期|Scheduling|安排/.test(body)) continue
      const hit = para.lines.filter((l) => /\bS8\b/.test(l.text)).map((l) => `${rel(file)}:${l.no}: ${l.text.trim()}`)
      flags.push(...hit)
    }
  }
  assert.deepEqual(flags, [], `S8（面试规划与排期）出现在筛选语境里：\n${flags.join('\n')}`)
})

test('T4 decision-rules.md 的 stage_code 示例必须是 "S10"', () => {
  const text = read(DECISION_RULES)
  const literals = [...text.matchAll(/"stage_code"\s*:\s*"([^"]+)"/g)].map((m) => m[1])
  assert.ok(literals.length >= 1, 'decision-rules.md 里找不到任何 "stage_code" JSON 示例')
  assert.deepEqual([...new Set(literals)], ['S10'], `stage_code 示例取值错误：${literals.join(', ')}`)
  assert.ok(
    text.includes('"decision_scope": "STAGE", "stage_code": "S10",'),
    '缺 §3.2 的汇总输出示例（"decision_scope": "STAGE", "stage_code": "S10",）',
  )

  // evaluation/** 的 stage_code 一律 S10；任何契约都不许再出现 "stage_code": "S11"/"S12"
  const flags: string[] = []
  for (const file of contractFiles()) {
    const t = read(file)
    for (const m of t.matchAll(/"stage_code"\s*:\s*"([^"]+)"/g)) {
      const value = m[1]
      if (/^S1[12]$/.test(value)) flags.push(`${rel(file)}: "stage_code": "${value}"`)
      if (rel(file).startsWith('evaluation/') && value !== 'S10') {
        flags.push(`${rel(file)}: evaluation 下 stage_code 必须是 S10，实际 "${value}"`)
      }
    }
  }
  assert.deepEqual([...new Set(flags)], [], `stage_code JSON 字面量错误：\n${flags.join('\n')}`)
})

test('T5 STAGE-CODES.md 的 12 行表与 0002_seed.sql / db/STAGE-CATALOG.md 逐字一致', () => {
  const sql = read(SEED)

  // 0002 用 JSON 对象种目录：{"order": 6, "code": "S6", "name": "简历接入与处理（Intake）", ...}
  let rows = [...sql.matchAll(/\{\s*"order"\s*:\s*(\d+)\s*,\s*"code"\s*:\s*"(S\d+)"\s*,\s*"name"\s*:\s*"([^"]+)"/g)].map((m) => ({
    order: Number(m[1]),
    code: m[2],
    name: m[3],
  }))
  // 兼容另一种字面量形状（若将来迁移改成 values 列表）：
  //   ('S6', '简历接入与处理（Intake）')
  if (rows.length === 0) {
    rows = [...sql.matchAll(/\(\s*'(S\d+)'\s*,\s*'([^']+)'\s*\)/g)].map((m, i) => ({ order: i + 1, code: m[1], name: m[2] }))
  }

  assert.equal(rows.length, 12, `0002_seed.sql 里应有 12 行阶段目录，实际 ${rows.length}`)
  assert.deepEqual(
    rows.map((r) => r.code),
    ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12'],
    '0002_seed.sql 的阶段码不是 S1..S12 顺序排列',
  )

  const doc = read(STAGE_CODES_DOC)
  const section = doc.split(/^## /m).find((chunk) => chunk.startsWith('1. '))
  assert.ok(section, 'STAGE-CODES.md 找不到 §1 权威表')
  const docRows = [...section.matchAll(/^\|\s*(S\d+)\s*\|\s*([^|]+?)\s*\|\s*$/gm)].map((m) => ({
    code: m[1],
    name: m[2],
  }))

  assert.equal(docRows.length, 12, `STAGE-CODES.md §1 应有 12 行，实际 ${docRows.length}`)
  assert.deepEqual(
    docRows,
    rows.map((r) => ({ code: r.code, name: r.name })),
    'STAGE-CODES.md 的 12 行表与 0002_seed.sql 的 stage_catalog 不一致（逐字比对）',
  )

  // 第三处：db/STAGE-CATALOG.md §3（多 sort_order / in_v1_scope 两列）——三处任一漂移都要红
  const dbDoc = read(join(REPO, 'db', 'STAGE-CATALOG.md'))
  const dbSection = dbDoc.split(/^## /m).find((chunk) => chunk.startsWith('3. '))
  assert.ok(dbSection, 'db/STAGE-CATALOG.md 找不到 §3（12 行目录）')
  const dbRows = [...dbSection.matchAll(/^\|\s*(S\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|/gm)].map((m) => ({
    code: m[1],
    name: m[2],
    order: Number(m[3]),
  }))
  assert.equal(dbRows.length, 12, `db/STAGE-CATALOG.md §3 应有 12 行，实际 ${dbRows.length}`)
  assert.deepEqual(
    dbRows.map((r) => ({ code: r.code, name: r.name })),
    docRows,
    'db/STAGE-CATALOG.md §3 与 contracts/STAGE-CODES.md §1 不一致（逐字比对）',
  )
})

test('T6 错误码改名全文一致（NOT_S11 / NOT_S12 已不存在）', () => {
  const stale: string[] = []
  for (const file of contractFiles().filter((f) => f !== STAGE_CODES_DOC)) {
    read(file)
      .split('\n')
      .forEach((line, idx) => {
        if (/NOT_S1[12]\b/.test(line)) stale.push(`${rel(file)}:${idx + 1}: ${line.trim()}`)
      })
  }
  assert.deepEqual(stale, [], `旧错误码名残留（封闭枚举只能整体改名）：\n${stale.join('\n')}`)

  // 正向断言：改名后的两个码确实存在（防止把整条规则删掉了事）
  const evalText = ['evaluation/decision-rules.md', 'evaluation/tool-contracts.md'].map((p) => read(join(CONTRACTS, p))).join('\n')
  assert.ok(evalText.includes('DECISION_SCOPE_NOT_S10'), '缺 DECISION_SCOPE_NOT_S10')
  assert.ok(evalText.includes('STAGE_CODE_NOT_S10'), '缺 STAGE_CODE_NOT_S10')
})

test('T7 对 15-architecture-hv.md 的引用必须标注「老仓 / 新仓未收录」', () => {
  const flags: string[] = []
  for (const file of contractFiles().filter((f) => f !== STAGE_CODES_DOC)) {
    read(file)
      .split('\n')
      .forEach((line, idx) => {
        if (!line.includes('15-architecture-hv.md')) return
        if (!line.includes('老仓') || !line.includes('新仓未收录')) {
          flags.push(`${rel(file)}:${idx + 1}: ${line.trim()}`)
        }
      })
  }
  assert.deepEqual(flags, [], `把不存在于本仓的文件当成可查依据：\n${flags.join('\n')}`)

  // STAGE-CODES.md 自己也必须写明"本仓未收录"
  assert.ok(read(STAGE_CODES_DOC).includes('未收录'), 'STAGE-CODES.md 必须写明 15-architecture-hv.md 在本仓未收录')
})

test('T8 域内阶段码：筛选域不出现排期码、身份域不把 S7 当身份阶段', () => {
  const flags: string[] = []

  // 筛选域（job-screening/）说的是 S3 / S6 / S7。出现 S8 只能是显式引用排期。
  for (const file of contractFiles().filter((f) => rel(f).startsWith('job-screening/'))) {
    read(file)
      .split('\n')
      .forEach((line, idx) => {
        if (!/\bS8\b/.test(line)) return
        if (!/面试|排期/.test(line)) flags.push(`${rel(file)}:${idx + 1}: ${line.trim()}`)
      })
  }

  // 身份解析是 S6 的一部分，不是独立阶段。identity/ 里的 S7 只能是引用"初筛"。
  for (const file of contractFiles().filter((f) => rel(f).startsWith('identity/'))) {
    read(file)
      .split('\n')
      .forEach((line, idx) => {
        if (!/\bS7\b/.test(line)) return
        if (!/筛/.test(line)) flags.push(`${rel(file)}:${idx + 1}: ${line.trim()}`)
      })
  }

  assert.deepEqual(flags, [], `域内阶段码错误（S8 属排期、身份解析属 S6）：\n${flags.join('\n')}`)
})
