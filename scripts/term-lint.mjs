#!/usr/bin/env node
// HR 可见面的术语机检：禁止在「HR 会读到的字符串」里出现「证据」二字。
//
// 为什么需要这个文件：
//   产品口径（docs/24 §6、AGENTS §0.2）要求 Agent/HR 界面输出只讲业务，不暴露
//   "证据/材料不全/没有可定位的原文证据"这类工程话术。「证据」是内部术语，
//   出现在 HR 可见文案里会诱导反向免责、索要材料、暴露内部口径。
//   这条口径靠 code review 守不住（字符串散落在少数几个文件里、混在注释与模板里），
//   所以做成机检：命中即 exit 1。
//
// 扫描面（默认无参数 = 当前树）：
//   <root>/src/client/**/*.{ts,tsx}
//   <root>/src/http/**/*.ts
//   <root>/skill/**/*.md
// 默认 <root> = <repo>/dsh/dsh-recruitment（本文件在 <repo>/scripts/）。
//
// 用法：
//   node scripts/term-lint.mjs                # 扫当前树
//   node scripts/term-lint.mjs <root>         # 扫指定根目录（对照旧树用）
//     <root> 下必须有 src/client/、src/http/、skill/ 三个子目录；
//     否则按"扫描根不存在"报错退出（缺失的扫描根不算绿）。
//     输出路径一律相对 <root>，用 / 分隔。
//
// 口径细节：
//   - .ts/.tsx（扫描面一 · 引号字面量）：只扫引号/模板字符串里的**字面量文本**，
//     跳过注释（// 与 /* */）。
//     模板字符串 ${...} 内部是**代码**：其中的字段名（如 evidenceCount）、
//     字符串字面量按代码规则处理——"$变量里的中文文案"仍然会被扫到，
//     但像 ${d.evidenceCount} 这样的标识符不会被误报成"中文文案含证据"。
//     实际上，标识符里出现中文「证据」本身也不合法（TS 标识符可含中文但项目里没有），
//     这里按"插值内部按代码扫"实现，避免把注释/标识符误当文案。
//   - .tsx（扫描面二 · 整行文本，补 JSX 文本节点盲区）：src/client 下的 .tsx 除了
//     上面的引号字面量扫描，还逐行扫「非注释行」——只要整行出现 BANNED 就记一条。
//     JSX 文本节点（<p>证据文本</p>）不在引号里，旧扫描面看不到，靠这一面补上。
//     注释行跳过：以 //、*、{/* 开头（允许前导空白）的行，以及处于 /* */ 块注释内
//     的行（含 */ 结尾行），跨行块注释状态正确跟踪。
//     两个扫描面按 path:line 去重，输出先按路径再按行号排序。
//   - .md：全文扫（markdown 没有注释概念）。
//   - allowlist：显式列出、每条带理由；按「相对路径 + 整行原文」精确匹配，
//     绝不宽到"包含 ❌ 就放过"。要新增例外必须在此处写理由，不允许散落豁免。
//
// 输出格式（统一）：<相对路径>:<行号>: <该行原文>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_ROOT = join(REPO_ROOT, 'dsh', 'dsh-recruitment')
const BANNED = '证据'

/**
 * 显式 allowlist。每条 = { path, line, reason }。
 * path: 相对扫描根的 posix 路径；line: 该行去掉行尾空白后的**完整原文**（精确匹配）。
 *
 * 当前唯一一类例外：skill 里 §6.2「禁止话术」清单的**引用行**——那一行是在
 * 告诉 Agent「这些话不许说」，其中的「证据」出现在被禁止的原话里，不是 HR 可见文案。
 * 五份 SKILL.md 各一行；按完整行匹配，不会因为别的行含 ❌ 就放过。
 */
const ALLOWLIST = [
  {
    path: 'skill/recruitment-s6-intake/SKILL.md',
    line: '- ❌「这里缺什么」「材料不全」「不能代表…」「不足以判断…」「没有可定位的原文证据」',
    reason: 'S6 §6.2 禁止话术清单：引用的是禁止 Agent 说出口的原话，不是 HR 可见文案',
  },
  {
    path: 'skill/recruitment-s7-screening/SKILL.md',
    line: '- ❌「这里缺什么」「材料不全」「不能代表…」「不足以判断…」「没有可定位的原文证据」',
    reason: 'S7 §6.2 禁止话术清单：引用的是禁止 Agent 说出口的原话，不是 HR 可见文案',
  },
  {
    path: 'skill/recruitment-s8-interview/SKILL.md',
    line: '- ❌「这里缺什么」「材料不全」「不能代表…」「不足以判断…」「没有可定位的原文证据」',
    reason: 'S8 §6.2 禁止话术清单：引用的是禁止 Agent 说出口的原话，不是 HR 可见文案',
  },
  {
    path: 'skill/recruitment-s9-transcript/SKILL.md',
    line: '- ❌「这里缺什么」「材料不全」「不能代表…」「不足以判断…」「没有可定位的原文证据」',
    reason: 'S9 §6.2 禁止话术清单：引用的是禁止 Agent 说出口的原话，不是 HR 可见文案',
  },
  {
    path: 'skill/recruitment-s10-decision/SKILL.md',
    line: '- ❌「这里缺什么」「材料不全」「不能代表…」「不足以判断…」「没有可定位的原文证据」',
    reason: 'S10 §6.2 禁止话术清单：引用的是禁止 Agent 说出口的原话，不是 HR 可见文案',
  },
]

const allowKeys = new Set(ALLOWLIST.map((item) => `${item.path}\u0000${item.line}`))

/** 递归收集文件；返回相对 root 的 posix 路径数组（稳定排序）。 */
function walk(root, sub, suffix) {
  const base = join(root, sub)
  if (!exists(base)) return null
  const out = []
  const stack = [base]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && suffix.some((s) => entry.name.endsWith(s))) {
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  return out.sort()
}

function exists(p) {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

/** 按行取原文（无行尾 \r），供输出与 allowlist 精确匹配。 */
function lineAt(lines, index) {
  return (lines[index] ?? '').replace(/\r$/, '')
}

/**
 * 单遍轻量词法扫描器：把 TS/TSX 源码拆成「字面量文本段」，每段记起始行号。
 * 状态：code / line-comment / block-comment / single / double / template。
 * 模板内部 ${...} 回到 code 状态（花括号计数），插值里的字符串/注释按普通代码处理；
 * 这样 ${d.evidenceCount} 之类的标识符不会被误报，而反引号里的中文文案仍会被扫到。
 * 只要某段字面量文本含 BANNED，就记下该段的起始行（输出整行原文，格式统一）。
 * 不引入任何依赖。
 */
function scanTs(source) {
  const lines = source.split('\n')
  const hits = new Set()
  const n = source.length
  let i = 0
  let line = 1

  // 帧栈：每个帧是一种「上下文」——code（普通代码，含模板插值）或 template（反引号文本）。
  // 帧内子状态（字符串/注释）用局部 mode 表示，闭合后必然回到本帧的 code。
  // frame = { kind: 'code'|'template', braceDepth: number, savedStartLine: number }
  //   code.braceDepth > 0  ⇒ 当前 code 帧处在 ${...} 内，遇到 } 要配平；
  //   配平到 0 时弹出该 code 帧，回到父帧（一定是 template），并恢复父模板的 startLine。
  //   savedStartLine: 进入本帧前的外层字面量起始行（0-based），${...} 退出时恢复，
  //   这样「`文本 ${expr} 后面的文字证据`」里的证据仍归属模板起始行。
  const frames = [{ kind: 'code', braceDepth: 0, savedStartLine: -1 }]
  let mode = 'code' // 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template'
  // 0-based 行号（与 lines 数组下标一致）；line 是 1-based，进入字面量时减一。
  let literalStartLine = -1

  const top = () => frames[frames.length - 1]

  while (i < n) {
    const c = source[i]
    const c2 = source.slice(i, i + 2)

    if (c === '\n') {
      if (mode === 'line-comment') mode = 'code'
      line += 1
      i += 1
      continue
    }

    if (mode === 'line-comment') {
      i += 1
      continue
    }

    if (mode === 'block-comment') {
      if (c2 === '*/') {
        mode = 'code'
        i += 2
      } else {
        i += 1
      }
      continue
    }

    if (mode === 'single' || mode === 'double') {
      if (c === '\\') {
        if (source[i + 1] === '\n') line += 1
        i += 2
        continue
      }
      const quote = mode === 'single' ? "'" : '"'
      if (c === quote) {
        mode = 'code'
        literalStartLine = -1
        i += 1
        continue
      }
      if (c === BANNED[0] && source.startsWith(BANNED, i)) hits.add(literalStartLine)
      i += 1
      continue
    }

    if (mode === 'template') {
      if (c === '\\') {
        if (source[i + 1] === '\n') line += 1
        i += 2
        continue
      }
      if (c2 === '${') {
        frames.push({ kind: 'code', braceDepth: 1, savedStartLine: literalStartLine })
        mode = 'code'
        literalStartLine = -1 // 插值内部按代码处理，不继承模板字面量行
        i += 2
        continue
      }
      if (c === '`') {
        frames.pop()
        const parent = top()
        mode = parent.kind === 'template' ? 'template' : 'code'
        literalStartLine = parent.kind === 'template' ? parent.savedStartLine : -1
        i += 1
        continue
      }
      if (c === BANNED[0] && source.startsWith(BANNED, i)) hits.add(literalStartLine)
      i += 1
      continue
    }

    // mode === 'code'：根据当前帧处理。
    const frame = top()
    if (frame.kind === 'code' && frame.braceDepth > 0) {
      if (c === '}') {
        frame.braceDepth -= 1
        if (frame.braceDepth === 0) {
          frames.pop()
          const parent = top()
          mode = 'template' // 父帧必是 template（${ 从 template 进入）
          literalStartLine = parent.savedStartLine
        }
        i += 1
        continue
      }
      if (c === '{') {
        frame.braceDepth += 1
        i += 1
        continue
      }
    }

    if (c2 === '//') {
      mode = 'line-comment'
      i += 2
      continue
    }
    if (c2 === '/*') {
      mode = 'block-comment'
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      mode = c === "'" ? 'single' : 'double'
      literalStartLine = line - 1
      i += 1
      continue
    }
    if (c === '`') {
      const start = line - 1
      frames.push({ kind: 'template', braceDepth: 0, savedStartLine: start })
      mode = 'template'
      literalStartLine = start
      i += 1
      continue
    }
    i += 1
  }

  return { hits, lines }
}

function scanMd(source) {
  const lines = source.split('\n')
  const hits = new Set()
  lines.forEach((text, index) => {
    if (text.includes(BANNED)) hits.add(index)
  })
  return { hits, lines }
}

/**
 * 第二扫描面：逐行扫 .tsx 的非注释行，只要整行出现 BANNED 就记该行（补 JSX 文本节点盲区）。
 * 与 scanTs 的「引号字面量」面互不替代：两者结果按 path:line 去重后统一输出。
 *
 * 注释跳过规则（按需求）：
 *   - 以 //、*、{/* 开头（允许前导空白）的行整行跳过；
 *   - 整行处于块注释内的行跳过（含块注释结束行），跨行块注释状态跨行跟踪。
 * 实现用字符级状态机：遇块注释起点进块注释、遇块注释终点出块注释，块内 // 与引号
 * 都不解释；行内 // 之后剩余部分是行注释。另外跟踪单/双/反引号，避免把字符串里的
 * 块注释起点误判成真起点（字符串里的 BANNED 由扫描面一负责，这里不重复报）。
 */
function scanTsxLines(source) {
  const lines = source.split('\n')
  const hits = new Set()
  let inBlock = false // 跨行 /* */ 块注释状态
  for (let li = 0; li < lines.length; li += 1) {
    const raw = lineAt(lines, li)
    const trimmed = raw.trimStart()
    const prefixComment =
      trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('{/*')
    let quote = null // null | "'" | '"' | '`'
    let found = false
    let i = 0
    while (i < raw.length) {
      if (inBlock) {
        const close = raw.indexOf('*/', i)
        if (close === -1) break
        inBlock = false
        i = close + 2
        continue
      }
      if (quote !== null) {
        if (raw[i] === '\\') {
          i += 2
          continue
        }
        if (raw[i] === quote) quote = null
        i += 1
        continue
      }
      const c = raw[i]
      const c2 = raw.slice(i, i + 2)
      if (c === "'" || c === '"' || c === '`') {
        quote = c
        i += 1
        continue
      }
      if (c2 === '//') break
      if (c2 === '/*') {
        inBlock = true
        i += 2
        continue
      }
      if (raw.startsWith(BANNED, i)) {
        found = true
        break
      }
      i += 1
    }
    if (found && !prefixComment) hits.add(li)
  }
  return hits
}

function main() {
  const arg = process.argv[2]
  const root = arg ? resolve(arg) : DEFAULT_ROOT
  if (!exists(root)) {
    console.error(`term-lint: 扫描根不存在: ${root}`)
    process.exit(2)
  }
  if (arg && process.argv.length > 3) {
    console.error('term-lint: 用法 node scripts/term-lint.mjs [root]（最多一个 root 参数）')
    process.exit(2)
  }

  const targets = [
    { sub: 'src/client', suffix: ['.ts', '.tsx'], kind: 'ts' },
    { sub: 'src/http', suffix: ['.ts'], kind: 'ts' },
    { sub: 'skill', suffix: ['.md'], kind: 'md' },
  ]

  // 两个扫描面共用同一个 Set：按 path:line 去重，避免同一行报两次。
  const findings = [] // { rel, index, raw }
  const findingKeys = new Set()
  function addFinding(rel, index, lines) {
    if (allowKeys.has(`${rel}\u0000${lineAt(lines, index).trimEnd()}`)) return
    const key = `${rel}\u0000${index}`
    if (findingKeys.has(key)) return
    findingKeys.add(key)
    findings.push({ rel, index, raw: lineAt(lines, index) })
  }

  for (const target of targets) {
    const files = walk(root, target.sub, target.suffix)
    if (files === null) {
      console.error(`term-lint: 扫描根缺失: ${join(root, target.sub)}`)
      process.exit(2)
    }
    for (const rel of files) {
      const source = readFileSync(join(root, rel), 'utf8')
      const { hits, lines } = target.kind === 'md' ? scanMd(source) : scanTs(source)
      for (const index of [...hits].sort((a, b) => a - b)) addFinding(rel, index, lines)
      // 扫描面二：仅 src/client 下的 .tsx，补 JSX 文本节点盲区。
      if (target.sub === 'src/client' && rel.endsWith('.tsx')) {
        for (const index of [...scanTsxLines(source)].sort((a, b) => a - b)) {
          addFinding(rel, index, lines)
        }
      }
    }
  }

  // 稳定输出：先按相对路径、再按行号排序。
  findings.sort((a, b) => (a.rel === b.rel ? a.index - b.index : a.rel < b.rel ? -1 : 1))

  if (findings.length > 0) {
    for (const f of findings) console.log(`${f.rel}:${f.index + 1}: ${f.raw}`)
    console.error(`term-lint: FAIL — ${findings.length} 处 HR 可见文案含「${BANNED}」`)
    process.exit(1)
  }
  console.log('term-lint: PASS — HR 可见文案无「证据」')
}

main()
