// 事件类型注册表的**机检测试**（本任务最重要的产出）。
//
// 它守的是 2026-11-14 那个真实缺陷的**根因**，而不是症状：
//   工具发 `resume.intake.received` / `scorecard.submit` / `decision.record`，
//   而 `routing.ts` 手抄的路由表只认 `resume_received` / `scorecard_submitted` /
//   `transcript_ready` —— 两边各写一份字符串，谁也没比谁多知道一点。结果 40 条真实事件
//   全部落到语义 Gate 被 `SEMANTIC_GATE_REJECTED` 拒掉，"事件自动触发"整条链是断的；
//   而单测因为手工构造事件名，一直是绿的。
//
// 现在两侧共用 `src/runtime/event-types.ts`，下面的静态扫描保证：
//   ① `src/**` 里**每一条**写给 `event_inbox` 的事件名都已登记（发射未登记的名字 → 红）；
//   ② 每个登记的 TOOL 生产者文件**真的引用了**注册表常量（登记一个没人发的名字 → 红）；
//   ③ 库触发器派生的事件名与 `db/migrations/0001_init.sql` §9.2 的挂载点逐项一致；
//   ④ 每个登记项的"确定性/忽略"裁决与它的运行时可达性一致（schema/0001 的不可能被路由）；
//   ⑤ 确定性路由表由注册表派生（不存在第二份手抄字符串）；
//   ⑥ 旧幽灵事件名（`resume_received` 等）不再被当作已接线。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DETERMINISTIC_EVENT_TYPES,
  EVENT_TYPE_NAME_PATTERN,
  EVENT_TYPE_REGISTRY,
  EVENT_TYPES,
  PRIORITY_BANDS,
  REGISTERED_EVENT_TYPES,
  ROW_GUARD_TRIGGERS,
  eventTypeRegistration,
  normalizeEventType,
  rowGuardEventType,
  type EventTypeDefinition,
} from '../../src/runtime/event-types.ts'
import { DETERMINISTIC_ROUTES, decideRoute } from '../../src/runtime/routing.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 包根（`dsh/dsh-recruitment`）。 */
const PKG_ROOT = join(HERE, '..', '..')
const SRC_ROOT = join(PKG_ROOT, 'src')
/** 仓库根（`recruitment-agent`）；`db/migrations` 在这里。 */
const REPO_ROOT = join(PKG_ROOT, '..', '..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations')

/** 测试租户（只为构造事件信封；路由是纯函数，不碰库）。 */
const TENANT = '11111111-1111-4111-8111-000000000001'
/** 构造 payload 用的稳定 UUID。 */
const UUID = '22222222-2222-4222-8222-000000000001'

// ---------------------------------------------------------------------------
//  源码静态扫描（去注释 → 找发射点 → 取事件名）
// ---------------------------------------------------------------------------

/**
 * 去掉 `//` 与 `/* *\/` 注释，**保留字符串内容**（包括模板字符串里的 SQL）。
 *
 * 为什么要保留字符串：事件名就写在 SQL 模板字符串里（`values ($1, 'internal',
 * 'resume.intake.received', ...)`），把字符串一并丢掉就什么都扫不到了。
 * 只去注释是为了避免注释里的示例名字造成假红。
 * @param source - 文件原文。
 * @returns 去注释后的文本（长度会变，只用于扫描）。
 */
function stripComments(source: string): string {
  let out = ''
  let index = 0
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code'
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; index += 2; continue }
      if (char === '/' && next === '*') { state = 'block'; index += 2; continue }
      if (char === "'" || char === '"' || char === '`') { state = char; out += char; index += 1; continue }
      out += char; index += 1; continue
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char }
      index += 1; continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; index += 2; continue }
      index += 1; continue
    }
    // 字符串内部：原样保留（含引号），处理转义。
    if (char === '\\') { out += char + (next ?? ''); index += 2; continue }
    if (char === state) { state = 'code'; out += char; index += 1; continue }
    out += char; index += 1
  }
  return out
}

/** 递归列出 `src/**\/*.ts`（不含 `.d.ts`）。 */
function sourceFiles(): readonly string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (name.endsWith('.ts')) files.push(path)
    }
  }
  walk(SRC_ROOT)
  return files
}

/** 包根相对的 posix 路径（`src/tools/x.ts`），与注册表的 `producer.file` 同形。 */
function packageRelative(path: string): string {
  return path.slice(PKG_ROOT.length + 1).replaceAll('\\', '/')
}

/** `insert into recruitment.event_inbox` 之后的一段源码（足够覆盖整条语句）。 */
const EVENT_INBOX_INSERT = /insert\s+into\s+recruitment\.event_inbox/gi
const INSERT_WINDOW_CHARS = 1_400
/** 参数区尾部长度：事件名作为绑定参数时，名字在 SQL 的闭合反引号之后。 */
const INSERT_PARAMS_TAIL_CHARS = 400

/**
 * 取出每个 `insert into recruitment.event_inbox` 语句的 SQL 片段 **+ 紧随其后的参数区**。
 *
 * 边界取到语句所在模板字符串结束（下一个反引号）再往下 400 字符：
 *   * 比"固定 N 字符窗口"准——固定窗口会把更远处的 `payload->>'interview_id'` 这种
 *     JSON 键误当成事件名；
 *   * 又必须带上参数区：事件名现在是**绑定参数**（`values ($1,'internal',$5,...)` +
 *     `[..., EVENT_TYPES.X]`），只扫 SQL 文本会漏掉"参数数组里写着裸字面量"的退化写法。
 * @param code - 去注释后的源码。
 * @returns 片段数组。
 */
function eventInboxInsertWindows(code: string): readonly string[] {
  const windows: string[] = []
  for (const match of code.matchAll(EVENT_INBOX_INSERT)) {
    const start = match.index ?? 0
    const closing = code.indexOf('`', start)
    const end = closing < 0 ? start + INSERT_WINDOW_CHARS : closing + INSERT_PARAMS_TAIL_CHARS
    windows.push(code.slice(start, end))
  }
  return windows
}

/** 单引号字符串字面量的内容（一行内、无转义；够扫 SQL 与配置键）。 */
const SINGLE_QUOTED = /'([^'\\\n]*)'/g

/**
 * "看着像事件名"的字面量：小写、至少含一个分隔段。
 *
 * 比注册表的命名约定（`EVENT_TYPE_NAME_PATTERN`，点分）**更宽**，故意把
 * `resume_received` 这种下划线旧名也纳入扫描——旧 bug 正是这个形态（幽灵路由名
 * 恰好没有发射方，而它长得也不像点分事件名）。SQL 里其它常见值
 * （`'internal'` 无分隔符、`'FALLBACK_KEY'` 大写、`'schema/0001'` 含斜杠）都不匹配。
 */
const SCANNED_EVENT_NAME_LIKE = /^[a-z][a-z0-9_]*(?:[._][a-z0-9_]+)+$/

/**
 * 扫描 `src/**` 里所有**直接写在 SQL 里**的事件名。
 * @returns 事件名 → 出现它的文件（包根相对路径）。
 */
function scannedLiteralEventNames(): ReadonlyMap<string, ReadonlySet<string>> {
  const found = new Map<string, Set<string>>()
  for (const file of sourceFiles()) {
    const relativePath = packageRelative(file)
    // 注册表自己当然写着全部名字；它不是"发射点"。
    if (relativePath === 'src/runtime/event-types.ts') continue
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const window of eventInboxInsertWindows(code)) {
      for (const match of window.matchAll(SINGLE_QUOTED)) {
        const literal = match[1]!
        // 只留"事件名形状"的字面量。
        if (!SCANNED_EVENT_NAME_LIKE.test(literal)) continue
        const entry = found.get(literal) ?? new Set<string>()
        entry.add(relativePath)
        found.set(literal, entry)
      }
    }
  }
  return found
}

/**
 * 扫描 `eventType: …` 形式的发射点（`insertInternalEvent` 这类本地 helper 的调用）。
 *
 * 判定规则：
 *   * `eventType: 'x.y'` —— 字面量必须已登记；
 *   * `eventType: EVENT_TYPES.X` —— 引用注册表，通过；
 *   * `eventType: IDENT` —— 若同文件有 `const IDENT = …`，右值必须是 `EVENT_TYPES.X`
 *     或已登记字面量（防"常量里藏一个裸名字"这种旧 bug 的形态）；
 *   * 其它（`eventType: string` 类型标注、`eventType: row.eventType` 透传、函数形参）
 *     **不是新写入的名字**，跳过——否则会把类型声明误报成事件名。
 * @returns 发现的问题（空数组 = 通过）。
 */
function scanEventTypeArguments(): readonly string[] {
  const problems: string[] = []
  for (const file of sourceFiles()) {
    const relativePath = packageRelative(file)
    if (relativePath === 'src/runtime/event-types.ts') continue
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const match of code.matchAll(/eventType:\s*([^\n,}]+)/g)) {
      const value = (match[1] ?? '').trim()
      if (value === '') continue
      if (value.startsWith("'")) {
        const literal = value.slice(1, value.lastIndexOf("'"))
        if (eventTypeRegistration(literal) === null) {
          problems.push(`${relativePath}: eventType: '${literal}' 未在注册表登记`)
        }
        continue
      }
      if (value.startsWith('EVENT_TYPES.')) continue
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) continue
      const declaration = new RegExp(`const\\s+${value}\\s*=\\s*([^\\n]+)`).exec(code)
      if (declaration === null) continue
      const right = declaration[1]!.trim()
      if (right.startsWith('EVENT_TYPES.')) continue
      if (right.startsWith("'")) {
        const literal = right.slice(1, right.lastIndexOf("'"))
        if (eventTypeRegistration(literal) === null) {
          problems.push(`${relativePath}: const ${value} = '${literal}' 未在注册表登记`)
        }
        continue
      }
      problems.push(`${relativePath}: eventType: ${value} 的右值既不是注册表常量也不是已登记字面量`)
    }
  }
  return problems
}

/** 从迁移文件里解析 §9.2 的状态护栏挂载点（`('table', 'column', 'prefix')`）。 */
function migrationRowGuardTriggers(): readonly { table: string; column: string; prefix: string }[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8')
  const start = sql.indexOf('-- 9.2 状态护栏')
  assert.ok(start >= 0, '0001_init.sql 里找不到 §9.2 状态护栏（迁移结构变了，扫描需要更新）')
  const end = sql.indexOf('end $$;', start)
  assert.ok(end > start, '0001_init.sql 的 §9.2 段落没有闭合')
  const block = sql.slice(start, end)
  const triggers: { table: string; column: string; prefix: string }[] = []
  for (const match of block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)'\)/g)) {
    triggers.push({ table: match[1]!, column: match[2]!, prefix: match[3]! })
  }
  return triggers
}

/** 按登记项构造一个能通过 envelope 的事件（纯路由用，不落库）。 */
function eventFor(definition: EventTypeDefinition, resolved: { type: 'INTAKE_RECORD'; id: string } | null) {
  const payload: Record<string, unknown> = {}
  if (definition.routing.kind === 'DETERMINISTIC') {
    for (const field of definition.routing.object.fields) payload[field] = UUID
  }
  return {
    event: {
      tenantId: TENANT,
      provider: 'internal',
      eventType: definition.type,
      payload,
      sourceObjectId: UUID,
      trustLevel: 'INTERNAL' as const,
    },
    resolved: definition.routing.kind === 'DETERMINISTIC' ? resolved : null,
  }
}

// ---------------------------------------------------------------------------
//  ① 发射侧 → 注册表
// ---------------------------------------------------------------------------

test('① 每个直接写进 event_inbox SQL 的事件名都已登记（发射未登记的名字 → 红）', () => {
  const scanned = scannedLiteralEventNames()
  const registered = new Set(REGISTERED_EVENT_TYPES)
  const unregistered: string[] = []
  for (const [name, files] of scanned) {
    if (registered.has(name)) continue
    unregistered.push(`${name}（${[...files].join(', ')}）`)
  }
  assert.deepEqual(
    unregistered,
    [],
    '以下事件名被写进了 event_inbox，但不在 src/runtime/event-types.ts 的注册表里：\n'
    + `${unregistered.join('\n')}\n`
    + '修法：把名字登记进 EVENT_TYPES + EVENT_TYPE_REGISTRY（并写清产生者与路由裁决），'
    + '不要在发射点留裸字面量。',
  )
  // 扫描必须是非空转的：domain 写路径仍然用裸字面量（本 lane 不改 src/domain），
  // 它必须被扫到，否则说明扫描规则失效了。
  assert.ok(
    scanned.has(EVENT_TYPES.APPLICATION_RUBRIC_VERSION_PINNED),
    '扫描没有命中 src/domain/stage-advance.ts 的 application.rubric_version.pinned —— '
    + '静态扫描规则失效（事件名可能被写在了扫描看不到的位置）',
  )
})

test('② eventType: … 的发射点都能追到注册表（字面量或 EVENT_TYPES 常量）', () => {
  assert.deepEqual(scanEventTypeArguments(), [])
})

// ---------------------------------------------------------------------------
//  ② 注册表 → 发射侧（反向）
// ---------------------------------------------------------------------------

/** 登记项的生产者文件绝对路径（TOOL/DOMAIN 相对包根，DB_TRIGGER 相对仓库根）。 */
function producerPath(definition: EventTypeDefinition): string {
  return join(definition.producer.kind === 'DB_TRIGGER' ? REPO_ROOT : PKG_ROOT, definition.producer.file)
}

test('③ 每个登记项都有真实生产者：TOOL 引用注册表常量、DOMAIN 用裸字面量、触发器来自迁移', () => {
  const problems: string[] = []
  for (const definition of EVENT_TYPE_REGISTRY) {
    const producerFile = producerPath(definition)
    let code = ''
    try {
      code = stripComments(readFileSync(producerFile, 'utf8'))
    } catch {
      problems.push(`${definition.type}: producer.file 不存在 → ${definition.producer.file}`)
      continue
    }
    if (definition.constKey !== null) {
      // 恒定式：常量键必须真的是这个事件名。
      if (EVENT_TYPES[definition.constKey] !== definition.type) {
        problems.push(`${definition.type}: constKey ${definition.constKey} 指向 ${EVENT_TYPES[definition.constKey]}`)
      }
    }
    if (definition.producer.kind === 'TOOL') {
      if (!code.includes("from '../runtime/event-types.ts'")) {
        problems.push(`${definition.type}: ${definition.producer.file} 没有 import ../runtime/event-types.ts`)
      }
      if (definition.constKey !== null && !code.includes(`EVENT_TYPES.${definition.constKey}`)) {
        problems.push(`${definition.type}: ${definition.producer.file} 里找不到 EVENT_TYPES.${definition.constKey}`)
      }
      // 发射语句里不许再有裸字面量（否则等于两边各写一份，正是本 bug 的形态）。
      for (const window of eventInboxInsertWindows(code)) {
        if (window.includes(`'${definition.type}'`)) {
          problems.push(`${definition.type}: ${definition.producer.file} 的 event_inbox 语句里仍写着裸字面量`)
        }
      }
      continue
    }
    if (definition.producer.kind === 'DOMAIN_WRITER') {
      if (!definition.producer.file.startsWith('src/domain/')) {
        problems.push(`${definition.type}: DOMAIN_WRITER 只允许登记 src/domain/** 的文件`)
      }
      if (!code.includes(`'${definition.type}'`)) {
        problems.push(`${definition.type}: ${definition.producer.file} 里找不到这个事件的字面量（登记的生产者不实）`)
      }
      continue
    }
    if (definition.producer.kind === 'HTTP_ACTION') {
      if (!definition.producer.file.startsWith('src/http/')) {
        problems.push(`${definition.type}: HTTP_ACTION 只允许登记 src/http/** 的文件`)
      }
      if (!code.includes("from '../runtime/event-types.ts'")) {
        problems.push(`${definition.type}: ${definition.producer.file} 没有 import ../runtime/event-types.ts`)
      }
      if (definition.constKey !== null && !code.includes(`EVENT_TYPES.${definition.constKey}`)) {
        problems.push(`${definition.type}: ${definition.producer.file} 里找不到 EVENT_TYPES.${definition.constKey}`)
      }
      for (const window of eventInboxInsertWindows(code)) {
        if (window.includes(`'${definition.type}'`)) {
          problems.push(`${definition.type}: ${definition.producer.file} 的 event_inbox 语句里仍写着裸字面量`)
        }
      }
      continue
    }
    // DB_TRIGGER 的可达性由 ④ 的迁移比对负责。
    if (!definition.type.endsWith('.changed')) {
      problems.push(`${definition.type}: DB_TRIGGER 事件名必须是 <table>.<column>.changed`)
    }
  }
  assert.deepEqual(problems, [])
})

test('④ 库触发器事件名与 db/migrations/0001_init.sql §9.2 的挂载点逐项一致', () => {
  const fromMigration = migrationRowGuardTriggers()
  assert.ok(fromMigration.length > 0, '迁移里一个 fn_row_guard 挂载点都没解析到（扫描规则失效）')
  // 注册表里的 (table, column) 集合
  const registeredPairs = new Set(ROW_GUARD_TRIGGERS.map((trigger) => `${trigger.table}.${trigger.column}`))
  const migrationPairs = new Set(fromMigration.map((trigger) => `${trigger.table}.${trigger.column}`))
  assert.deepEqual(
    [...migrationPairs].sort(),
    [...registeredPairs].sort(),
    '迁移新加了 fn_row_guard 触发器，但 src/runtime/event-types.ts 的 ROW_GUARD_TRIGGERS 没跟上'
    + '（或反过来）。两者必须逐项一致，否则会有事件名永远无人登记。',
  )
  // 派生名也要一致（防止 rowGuardEventType 改名后注册表与生产脱节）。
  const registeredNames = new Set(
    EVENT_TYPE_REGISTRY.filter((definition) => definition.producer.kind === 'DB_TRIGGER').map((definition) => definition.type),
  )
  const derivedNames = new Set(fromMigration.map((trigger) => rowGuardEventType(trigger)))
  assert.deepEqual([...registeredNames].sort(), [...derivedNames].sort())
})

// ---------------------------------------------------------------------------
//  裁决一致性
// ---------------------------------------------------------------------------

test('⑤ 登记项合法：名字唯一且符合点分约定、原因可审计、裁决与运行时可达性一致', () => {
  const seen = new Set<string>()
  for (const definition of EVENT_TYPE_REGISTRY) {
    assert.match(definition.type, EVENT_TYPE_NAME_PATTERN, `${definition.type} 不符合 <对象>.<动作> 命名约定`)
    assert.equal(seen.has(definition.type), false, `重复登记：${definition.type}`)
    seen.add(definition.type)
    assert.ok(
      definition.producer.file.trim() !== '' && definition.producer.detail.trim() !== '',
      `${definition.type}: 必须写清产生者（哪个工具/触发器）`,
    )
    if (definition.routing.kind === 'IGNORED') {
      assert.ok(
        definition.routing.reason.length >= 20,
        `${definition.type}: IGNORED 必须给出可审计的原因，不能是空话`,
      )
      continue
    }
    assert.ok(definition.routing.taskType.trim() !== '', `${definition.type}: 确定性事件必须给出 task type`)
    assert.ok(definition.routing.priority >= 1 && definition.routing.priority <= 5)
    // 确定性事件必须真的会进待路由队列：schema/0001 的事件被 listPendingEvents 排除，
    // 登记成确定性 = 永远路由不到的假登记。
    assert.notEqual(
      definition.normalizerVersion,
      'schema/0001',
      `${definition.type}: schema/0001 的审计事件不进待路由队列，不能登记成 DETERMINISTIC`,
    )
    assert.ok(
      definition.routing.object.fields.length > 0 || definition.routing.object.byEventRow !== null,
      `${definition.type}: 确定性事件必须声明业务对象来源（payload 字段或事件行反查）`,
    )
  }
  // 反向：schema/0001 的审计事件只允许 IGNORED。
  for (const definition of EVENT_TYPE_REGISTRY) {
    if (definition.normalizerVersion !== 'schema/0001') continue
    assert.equal(definition.routing.kind, 'IGNORED', `${definition.type}: schema/0001 事件只能是 IGNORED`)
  }
})

test('⑥ 确定性路由表由注册表派生，不存在第二份手抄字符串', () => {
  assert.deepEqual(
    Object.keys(DETERMINISTIC_ROUTES).sort(),
    DETERMINISTIC_EVENT_TYPES.map((definition) => normalizeEventType(definition.type)).sort(),
  )
  for (const definition of DETERMINISTIC_EVENT_TYPES) {
    const route = DETERMINISTIC_ROUTES[normalizeEventType(definition.type)]!
    assert.equal(route.taskType, definition.routing.taskType)
    assert.equal(route.title, definition.routing.title)
    assert.equal(route.priority, definition.routing.priority)
    assert.equal(route.objectType, definition.routing.object.type)
    assert.deepEqual([...route.idFields], [...definition.routing.object.fields])
  }
})

test('⑦ 每个登记项的纯路由结论符合登记（确定性建任务 / IGNORED 带原因）', () => {
  const intakeRecord = { type: 'INTAKE_RECORD' as const, id: UUID }
  for (const definition of EVENT_TYPE_REGISTRY) {
    const fixture = eventFor(definition, intakeRecord)
    const decision = decideRoute(fixture.event, undefined, fixture.resolved)
    if (definition.routing.kind === 'IGNORED') {
      assert.equal(decision.kind, 'ignored', `${definition.type} 应被忽略`)
      assert.match(
        (decision as { reason: string }).reason,
        /^REGISTERED_IGNORED: /,
        `${definition.type} 的忽略原因必须是显式登记的裁决（不是语义 Gate 兜底）`,
      )
      continue
    }
    assert.equal(decision.kind, 'deterministic', `${definition.type} 应走确定性路由`)
    const deterministic = decision as { taskType: string; businessObject: { type: string; id: string } }
    assert.equal(deterministic.taskType, definition.routing.taskType)
    assert.equal(deterministic.businessObject.type, definition.routing.object.type)
    assert.equal(deterministic.businessObject.id, UUID)
  }
})

test('⑧ resume.intake.received 缺 intake_record 时不猜 ID（BUSINESS_OBJECT_NOT_FOUND）', () => {
  // 真实发射的 payload 只有 sha256 / file_name / pages / source_kind（没有对象 UUID）。
  const decision = decideRoute({
    tenantId: TENANT,
    provider: 'internal',
    eventType: EVENT_TYPES.RESUME_INTAKE_RECEIVED,
    payload: { sha256: 'f'.repeat(64), file_name: 'resume.pdf', pages: 1, source_kind: 'LOCAL_FILE' },
    sourceObjectId: 'f'.repeat(64),
    trustLevel: 'INTERNAL',
  }, undefined, null)
  assert.equal(decision.kind, 'ignored')
  assert.match((decision as { reason: string }).reason, /^BUSINESS_OBJECT_NOT_FOUND: /)
  assert.match((decision as { reason: string }).reason, /INTAKE_RECORD/)
})

// ---------------------------------------------------------------------------
//  准入没放宽 + 回归守卫
// ---------------------------------------------------------------------------

test('⑨ 未登记的事件仍然只走语义 Gate：准入规则一个字都没放宽', () => {
  const base = { tenantId: TENANT, provider: 'feishu', eventType: 'unclassified.external.signal', payload: { text: 'hi' } }
  // 外部未登记 → 拒
  const external = decideRoute({ ...base, trustLevel: 'UNTRUSTED_EXTERNAL' })
  assert.equal(external.kind, 'ignored')
  assert.match((external as { reason: string }).reason, /^SEMANTIC_GATE_REJECTED: /)
  // 内部但未声明语义、也没有 intent → 拒
  const internalNoIntent = decideRoute({ ...base, provider: 'internal', trustLevel: 'INTERNAL' })
  assert.equal(internalNoIntent.kind, 'ignored')
  assert.match((internalNoIntent as { reason: string }).reason, /^SEMANTIC_GATE_REJECTED: /)
  // 内部 + intent → 语义准入，落 ROUTER_TRIAGE
  const admitted = decideRoute({
    ...base,
    provider: 'internal',
    trustLevel: 'INTERNAL',
    payload: { intent: 'headcount change in dept A' },
  })
  assert.equal(admitted.kind, 'semantic')
  assert.equal((admitted as { taskType: string }).taskType, 'ROUTER_TRIAGE')
})

test('⑩ 回归守卫：旧路由表里的幽灵事件名不再被当成"已接线"', () => {
  // 这些名字曾经写在 routing.ts 的确定性表里，却**没有任何发射方**：
  // 单测手工构造它们时永远绿，真实工具发的名字却一个都进不来（40 条被 Gate 拒掉）。
  // 要重新启用它们，必须先有真实发射方（工具/连接器），再登记进注册表。
  const ghosts = [
    'resume_received',
    'application_resume_received',
    'intake_resume_received',
    'scorecard_submitted',
    'transcript_ready',
    'application_stage_entered',
    'interview_scheduled',
    'candidate_reply',
  ]
  for (const ghost of ghosts) {
    assert.equal(eventTypeRegistration(ghost), null, `${ghost} 不该被静默登记：它没有真实发射方`)
  }
})

test('⑪ 注册表本身可审计：行数 + 确定性/忽略的分类计数（变化要显式改测试）', () => {
  // 数字变化不一定是错，但它必须是一个**显式决定**：改注册表就顺手核对这里。
  assert.equal(REGISTERED_EVENT_TYPES.length, EVENT_TYPE_REGISTRY.length)
  assert.equal(DETERMINISTIC_EVENT_TYPES.length, 2, '确定性事件目前只有 resume.intake.received / scorecard.submit')
  assert.equal(
    EVENT_TYPE_REGISTRY.filter((definition) => definition.routing.kind === 'IGNORED').length,
    EVENT_TYPE_REGISTRY.length - DETERMINISTIC_EVENT_TYPES.length,
  )
  // 每个事件名都能查回自己（规范化幂等）。
  for (const name of REGISTERED_EVENT_TYPES) {
    assert.equal(eventTypeRegistration(name)?.type, name)
  }
})

test('⑫-a criterion.override.recorded 登记为 IGNORED（schema/0001 审计事实，不建任务）', () => {
  const registration = eventTypeRegistration(EVENT_TYPES.CRITERION_OVERRIDE_RECORDED)
  assert.ok(registration, 'criterion.override.recorded 必须登记')
  assert.equal(registration.type, 'criterion.override.recorded')
  assert.equal(registration.constKey, 'CRITERION_OVERRIDE_RECORDED')
  assert.equal(registration.normalizerVersion, 'schema/0001')
  assert.equal(registration.routing.kind, 'IGNORED')
  assert.ok(registration.routing.kind === 'IGNORED' && registration.routing.reason.length >= 20)
  assert.equal(registration.producer.kind, 'TOOL')
  assert.equal(registration.producer.file, 'src/tools/criterion-override.ts')
})

test('⑫ EVENT_TYPES 与 EVENT_TYPE_REGISTRY 双向一致（加常量忘登记 → 红）', () => {
  // 发射方引用的是 `EVENT_TYPES.X`，若只加了常量却没进注册表，上面的静态扫描看不见
  // （SQL 里是 `${EVENT_TYPES.X}` 插值，没有裸字面量），所以必须在这里双向对账：
  // 每个常量值都要有登记项，每个登记项（非触发器）的 constKey 都要指回同名常量。
  const registered = new Set(REGISTERED_EVENT_TYPES)
  for (const [key, value] of Object.entries(EVENT_TYPES)) {
    assert.ok(
      registered.has(value),
      `EVENT_TYPES.${key} = '${value}' 没有登记进 EVENT_TYPE_REGISTRY（发射了但没裁决）`,
    )
  }
  for (const definition of EVENT_TYPE_REGISTRY) {
    if (definition.constKey === null) continue
    assert.equal(EVENT_TYPES[definition.constKey], definition.type, `${definition.type} 的 constKey 指错了常量`)
  }
})

// ---------------------------------------------------------------------------
//  ⑬ E6-1：人的即时操作（priority=1）优先于后台批量/常规（priority≥3）
//
//  验收判据：批量导入时新增一条「人在等」的任务，必须能被先认领。
//  实现侧只改"创建任务时给什么 priority"（event-types.ts 的登记表），
//  认领排序本身（store/claim.ts:59 的 `order by priority, next_run_at nulls first,
//  created_at`）一个字都没动。这里用纯函数/内存证据证明四件事：
//    ① 登记表的档位：scorecard.submit = 1（人在等）、resume.intake.received = 3（常规后台）；
//    ② DETERMINISTIC_ROUTES 从登记表派生出的 priority 与之一致；
//    ③ decideRoute 产出的确定性任务决策带同样的 priority；
//    ④ 按 claim.ts 的排序键排序时，先建的 priority=3 任务输给后建的 priority=1 任务。
//  真 DB 的优先认领正例/负例在 test/runtime/intake-routing.test.ts（需要一次性空库）。
// ---------------------------------------------------------------------------
test('⑬ E6-1：人在等(1) 比常规后台(3) 先认领——登记表/派生路由/路由决策/排序键四层一致', () => {
  const scorecard = eventTypeRegistration(EVENT_TYPES.SCORECARD_SUBMIT)
  const resume = eventTypeRegistration(EVENT_TYPES.RESUME_INTAKE_RECEIVED)
  assert.ok(scorecard !== null && resume !== null)
  assert.equal(scorecard.routing.kind, 'DETERMINISTIC')
  assert.equal(resume.routing.kind, 'DETERMINISTIC')

  // ① 登记表的 priority 档位（1 = 人在等，3 = 常规后台；数字越小越先认领）。
  assert.equal(
    scorecard.routing.priority,
    PRIORITY_BANDS.HUMAN_WAITING,
    'scorecard.submit（人在页面提交面评）必须是 1 = 人在等',
  )
  assert.equal(scorecard.routing.priority, 1)
  assert.equal(
    resume.routing.priority,
    PRIORITY_BANDS.BACKGROUND,
    'resume.intake.received（后台材料摄取）必须是 3 = 常规后台',
  )
  assert.equal(resume.routing.priority, 3)
  assert.ok(scorecard.routing.priority < resume.routing.priority, '人在等的优先级必须严格高于常规后台')

  // 批量档只在 constants 里留定义，本版不实现批量判定。
  assert.equal(PRIORITY_BANDS.BATCH, 4)

  // ② 派生路由表（routing.ts 从登记表 build，无第二份手抄）的 priority 与登记表一致。
  assert.equal(DETERMINISTIC_ROUTES[normalizeEventType(EVENT_TYPES.SCORECARD_SUBMIT)]!.priority, 1)
  assert.equal(DETERMINISTIC_ROUTES[normalizeEventType(EVENT_TYPES.RESUME_INTAKE_RECEIVED)]!.priority, 3)

  // ③ decideRoute 的确定性决策确实把 priority 带出来（建任务时会写进 business_task.priority）。
  const scorecardDecision = decideRoute(
    eventFor(scorecard, null).event,
    undefined,
    eventFor(scorecard, null).resolved,
  )
  const resumeDecision = decideRoute(
    eventFor(resume, { type: 'INTAKE_RECORD', id: UUID }).event,
    undefined,
    eventFor(resume, { type: 'INTAKE_RECORD', id: UUID }).resolved,
  )
  assert.equal(scorecardDecision.kind, 'deterministic')
  assert.equal(resumeDecision.kind, 'deterministic')
  assert.equal((scorecardDecision as { priority: number }).priority, 1)
  assert.equal((resumeDecision as { priority: number }).priority, 3)

  // ④ 纯函数排序证明"后建的 1 比先建的 3 先认领"：键与 claim.ts:59 逐字一致。
  //    这里刻意让 3 号任务 created_at 更早（模拟批量导入已经排了一队），
  //    1 号任务晚到；priority 是第一排序键，所以 1 号仍排在最前。
  const queued = [
    { label: '批量导入的常规任务(3)', priority: 3, nextRunAt: 0, createdAt: 1 },
    { label: '人在等的新任务(1)', priority: 1, nextRunAt: 0, createdAt: 2 },
  ]
  const claimed = [...queued].sort(
    (a, b) => a.priority - b.priority || a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt,
  )
  assert.equal(claimed[0]!.label, '人在等的新任务(1)', '后建的人等任务必须排在先建的常规任务前')
  assert.equal(claimed[0]!.priority, 1)
})
