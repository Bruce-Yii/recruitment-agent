// Web Gate 取证：在真实 `dsh --profile recruitment` 的 Web 页面里打开一个已完成的
// S6→S7 会话，抓页面正文 + 截图；然后**刷新页面**再抓一次，证明结果不是内存态。
//
// 用法：node manual/web-gate-verify.mjs <out-dir> <cdp-port> <session-title-prefix>
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? '.'
const PORT = Number(process.argv[3] ?? 9557)
const TITLE_PREFIX = process.argv[4] ?? '这份简历要收进招聘系统'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (page === undefined) throw new Error('no http page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let nextId = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const resolve = pending.get(message.id)
  if (resolve !== undefined) { pending.delete(message.id); resolve(message) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return response.result?.result?.value
}
async function realClick(elementExpression, label) {
  const rect = await evaluate(`(() => { const el = ${elementExpression}; if (!el) return null; const r = el.getBoundingClientRect(); if (r.width === 0) return null; return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
  if (rect === null) {
    console.log(`click ${label}: NOT FOUND`)
    return false
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  console.log(`click ${label}: ok`)
  await sleep(1800)
  return true
}
async function snapshot(tag) {
  let text = ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(1000)
    text = await evaluate('document.body.innerText')
    if (text.includes('初筛') || text.includes('招聘')) break
  }
  writeFileSync(join(OUT, `web-body-${tag}.txt`), text, 'utf8')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) writeFileSync(join(OUT, `web-page-${tag}.png`), Buffer.from(shot.result.data, 'base64'))
  const has = (needle) => text.includes(needle)
  console.log(`[${tag}] chars=${text.length} 初筛=${has('初筛')} 待人工=${has('待人工')} 结构化=${has('结构化')} 下一步=${has('下一步')}`)
  return text
}

await send('Runtime.enable')
await send('Page.enable')
// 关掉可能存在的内测声明（只在首次出现）。
await realClick(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '继续')`, '继续(内测声明)')
// 展开 recruitment-os 工作区。
const expanded = await evaluate(`[...document.querySelectorAll('[role=treeitem]')].find((e) => (e.innerText || '').trim() === 'recruitment-os')?.getAttribute('aria-expanded')`)
if (expanded !== 'true') {
  await realClick(`[...document.querySelectorAll('[role=treeitem]')].find((e) => (e.innerText || '').trim() === 'recruitment-os')`, '展开 recruitment-os')
} else {
  console.log('recruitment-os already expanded')
}
// 打开目标会话。
const opened = await realClick(`[...document.querySelectorAll('[role=treeitem]')].find((e) => (e.innerText || '').includes(${JSON.stringify(TITLE_PREFIX)}))`, `会话 ${TITLE_PREFIX}`)
if (!opened) {
  console.log('session row not found; body follows')
  console.log(await evaluate('document.body.innerText'))
  process.exitCode = 1
  ws.close()
} else {
  const before = await snapshot('before-refresh')
  await send('Page.reload', { ignoreCache: false })
  console.log('page reloaded; waiting for re-render…')
  await sleep(4000)
  const after = await snapshot('after-refresh')
  const same = before.includes('待人工') && after.includes('待人工') && after.includes('初筛')
  console.log(`refresh persisted: ${same}`)
  if (!same) process.exitCode = 1
  ws.close()
}
