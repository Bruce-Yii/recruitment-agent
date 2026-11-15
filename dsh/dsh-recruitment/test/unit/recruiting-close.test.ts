// 岗位关闭（`job/close` 人类闸门）测试：**弹窗文案逐字** + 组件静态断言 + A 的 `terminatedLines`/`parseJobCloseEnvelope`。
//
// 契约出处：
//   · `work/d5/joblife/CONTRACT.md` §3：弹窗文案逐字（本测试把合同原文段落作为断言字符串）；
//   · `work/d5/joblife/CONTRACT.md` §1：200 响应键（contract_version/job/terminated/actor/replayed）；
//   · `work/d5/w2b/INTERFACE.md` §2.6：`CLOSE_JOB_DIALOG_TEXT` 逐字 + testid + 取消零请求。
// 组件没有 DOM 测试库（不新增依赖）→ 组件用**源码静态断言**；纯函数用 A 的 actions.ts 直接跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** 弹窗组件源码（相对本测试文件；不依赖机器绝对路径）。 */
const DIALOG_SOURCE = readFileSync(new URL('../../src/client/recruiting/close-job-dialog.tsx', import.meta.url), 'utf8')

/** `work/d5/joblife/CONTRACT.md` §3 的原文块（逐字；含续行 6 个空格缩进）。 */
const CONTRACT_BLOCK = [
  '标题：关闭岗位并终止在途申请？',
  '正文：关闭后该岗位不再接收新申请，招聘流程停止。',
  '      该岗位下所有进行中（ACTIVE / ON_HOLD）的申请将被终止（status=CLOSED），',
  '      尚未开始的面试将被取消，与该岗位相关的未完成任务将被取消。',
  '      历史记录保留；进行中/已面试的面试与已有评价不会被改写。',
  '      此操作不可自动恢复，且必须由人工确认。',
  '可选输入：关闭原因（选填，最多 500 字）',
  '主按钮：确认关闭并终止在途申请',
  '次按钮：取消',
].join('\n')

/** 从组件源码提取 `field: '...'` 形式的字符串字面量（常量是 `as const` 对象）。 */
function sourceLiteral(field: string): string {
  const match = new RegExp(`${field}:\\s*'([^']*)'`).exec(DIALOG_SOURCE)
  assert.ok(match !== null, `CLOSE_JOB_DIALOG_TEXT 缺少字段 ${field}`)
  return match[1]
}

/** 从组件源码提取 `bodyLines: [...]` 里的字符串字面量（保持顺序）。 */
function sourceBodyLines(): string[] {
  const block = /bodyLines:\s*\[([\s\S]*?)\]/.exec(DIALOG_SOURCE)
  assert.ok(block !== null, 'CLOSE_JOB_DIALOG_TEXT 缺少 bodyLines')
  return [...block[1].matchAll(/'([^']*)'/g)].map((match) => match[1])
}

test('CLOSE_JOB_DIALOG_TEXT 与 CONTRACT §3 逐字一致（标题/正文/可选输入/主按钮/次按钮）', () => {
  const composed = [
    `标题：${sourceLiteral('title')}`,
    `正文：${sourceBodyLines()[0]}`,
    ...sourceBodyLines()
      .slice(1)
      .map((line) => `      ${line}`),
    `可选输入：${sourceLiteral('reasonLabel')}`,
    `主按钮：${sourceLiteral('confirmLabel')}`,
    `次按钮：${sourceLiteral('cancelLabel')}`,
  ].join('\n')

  assert.equal(composed, CONTRACT_BLOCK, '弹窗文案必须与合同 §3 逐字一致（diff 必须为空）')
})

test('弹窗文案关键段落逐字（INTERFACE §2.6 点名两段必须原样出现）', () => {
  const lines = sourceBodyLines()
  assert.ok(lines.includes('关闭后该岗位不再接收新申请，招聘流程停止。'), '缺少"不再接收新申请，招聘流程停止"段')
  assert.ok(
    lines.includes('该岗位下所有进行中（ACTIVE / ON_HOLD）的申请将被终止（status=CLOSED），'),
    '缺少"在途申请将被终止（status=CLOSED）"段',
  )
  assert.ok(lines.includes('此操作不可自动恢复，且必须由人工确认。'), '缺少"必须由人工确认"段')
  assert.equal(sourceLiteral('confirmLabel'), '确认关闭并终止在途申请')
  assert.equal(sourceLiteral('cancelLabel'), '取消')
  assert.equal(sourceLiteral('reasonLabel'), '关闭原因（选填，最多 500 字）')
})

test('close-job-dialog.tsx 静态断言：取消只调 onCancel、组件内零网络调用、testid 齐全、原因 ≤500', () => {
  // 注释里可能解释"不 fetch / 不读 localStorage"，静态断言只看**代码**（去掉注释后再匹配）。
  const CODE = DIALOG_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // 1) 零网络调用：组件内不得出现 fetch( / XMLHttpRequest / sendBeacon / localStorage。
  assert.deepEqual(CODE.match(/fetch\s*\(/g) ?? [], [], '组件内不得 fetch（取消 = 零请求）')
  assert.equal(/XMLHttpRequest/.test(CODE), false)
  assert.equal(/sendBeacon/.test(CODE), false)
  assert.equal(/localStorage/.test(CODE), false, '不读 localStorage（session 由 props 传入）')
  assert.equal(/sessionStorage/.test(CODE), false)

  // 2) 取消按钮只调 onCancel（唯一副作用）。
  assert.ok(/onClick=\{onCancel\}/.test(DIALOG_SOURCE), '取消按钮必须只调用 onCancel')

  // 3) 冻结 testid 齐全（浏览器证据读这些）。
  for (const testid of ['close-job-dialog', 'close-job-confirm', 'close-job-cancel', 'close-job-reason']) {
    assert.ok(DIALOG_SOURCE.includes(`data-testid="${testid}"`), `缺少 data-testid="${testid}"`)
  }

  // 4) 原因输入上限 500（maxLength + slice 双保险）。
  assert.ok(/CLOSE_JOB_REASON_MAX\s*=\s*500/.test(DIALOG_SOURCE), '原因上限必须是 500')
  assert.ok(/maxLength=\{CLOSE_JOB_REASON_MAX\}/.test(DIALOG_SOURCE), 'textarea 必须挂 maxLength')
  assert.ok(/\.slice\(0,\s*CLOSE_JOB_REASON_MAX\)/.test(DIALOG_SOURCE), 'onChange 必须再裁剪一次（程序化赋值也 ≤500）')

  // 5) 确认才 onConfirm：按钮 onClick 里调用 onConfirm(reason.trim())。
  assert.ok(/onConfirm\(reason\.trim\(\)\)/.test(DIALOG_SOURCE), '主按钮必须传裁剪后的 reason')
})

test('作业关闭信封：parseJobCloseEnvelope 键名逐字（CONTRACT §1）+ terminatedLines 逐条', async (t) => {
  const module = await import('../../src/client/recruiting/actions.ts').catch(() => null)
  if (module === null || typeof module.parseJobCloseEnvelope !== 'function' || typeof module.terminatedLines !== 'function') {
    t.skip('A 的 actions.ts 未就绪（parseJobCloseEnvelope/terminatedLines），跳过信封断言')
    return
  }

  const envelope = module.parseJobCloseEnvelope(
    JSON.stringify({
      contract_version: '1.0.0',
      job: {
        job_id: 'job-1',
        status: 'CLOSED',
        record_version: 2,
        status_changed_at: '2026-11-15T10:00:00.000Z',
        status_changed_by_actor_id: 'actor-103',
      },
      terminated: {
        applications_total: 4,
        applications_closed: 4,
        applications_already_closed: 1,
        interviews_cancelled: 2,
        interviews_already_terminal: 1,
        interviews_occurred_kept: 2,
        tasks_cancelled: 3,
        task_attempts_cancelled: 1,
      },
      actor: { actor_id: 'actor-103', alias: 'recruiter', display_name: '演示-HR 专员' },
      replayed: false,
    }),
  )
  assert.ok(envelope !== null, '合法信封必须解析成功')
  assert.equal(envelope.contractVersion, '1.0.0')
  assert.equal(envelope.job.jobId, 'job-1')
  assert.equal(envelope.job.status, 'CLOSED')
  assert.equal(envelope.job.recordVersion, 2)
  assert.equal(envelope.job.statusChangedByActorId, 'actor-103')
  assert.equal(envelope.terminated.applicationsTotal, 4)
  assert.equal(envelope.terminated.interviewsOccurredKept, 2)
  assert.equal(envelope.actor.alias, 'recruiter')
  assert.equal(envelope.replayed, false)

  const lines = module.terminatedLines(envelope.terminated)
  assert.equal(lines.length, 8, '终止计数逐条（8 个计数键）')
  for (const line of lines) {
    assert.equal(typeof line, 'string')
    assert.ok(line.trim() !== '', '每条计数行都必须有文案（缺失数值不编造）')
  }
  assert.ok(lines[0].includes('4'), '第一行是进入终止范围的申请数')
  assert.ok(lines.join('\n').includes('已发生/进行中的面试'), '必须区分"已发生/进行中保留"的面试（不伪造取消）')

  // 坏输入：非 JSON / 缺 job / 缺 terminated → null（不猜）。
  assert.equal(module.parseJobCloseEnvelope('not-json'), null)
  assert.equal(module.parseJobCloseEnvelope(''), null)
  assert.equal(module.parseJobCloseEnvelope(JSON.stringify({ contract_version: '1.0.0' })), null)

  // 空计数也要产出 8 行（0 是真实计数，不当缺失）。
  const zeroLines = module.terminatedLines({
    applicationsTotal: 0,
    applicationsClosed: 0,
    applicationsAlreadyClosed: 0,
    interviewsCancelled: 0,
    interviewsAlreadyTerminal: 0,
    interviewsOccurredKept: 0,
    tasksCancelled: 0,
    taskAttemptsCancelled: 0,
  })
  assert.equal(zeroLines.length, 8)
})
