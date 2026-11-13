// 在真实 DSH Web 页面里输入一句自然语言目标并回车，然后等 Agent 跑完，
// 把页面正文与截图落盘（manual 验证 Web Gate 用；不是产品代码）。
//
// 用法：node manual/web-gate-compose.mjs <out-dir> <cdp-port> <goal-file>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? '.'
const PORT = Number(process.argv[3] ?? 9556)
const GOAL = readFileSync(process.argv[4], 'utf8').trim()
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

await send('Runtime.enable')
await send('Page.enable')

const before = await evaluate('document.body.innerText')
if (!before.includes('描述你想要构建的内容')) throw new Error('composer not ready')

await evaluate(`document.querySelector('[data-composer-input]').focus()`)
await send('Input.insertText', { text: GOAL })
await sleep(500)
const typed = await evaluate(`document.querySelector('[data-composer-input]').innerText`)
console.log(`typed ${typed.length} chars: ${typed.slice(0, 80)}…`)
if (typed.trim() === '') throw new Error('composer stayed empty')

await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
console.log('sent Enter; waiting for the agent…')

let text = ''
let settled = 0
for (let attempt = 0; attempt < 120; attempt += 1) {
  await sleep(3000)
  text = await evaluate('document.body.innerText')
  const busy = await evaluate(`Boolean(document.querySelector('[aria-label="停止"],[aria-label="停止生成"],[data-busy="true"]'))`)
  if (attempt % 5 === 0) console.log(`  ${attempt * 3}s: ${text.length} chars, busy=${busy}`)
  if (text.includes('待人工') && (text.includes('初筛') || text.includes('初筛结论'))) {
    settled += 1
    if (settled >= 2) break
  }
}

writeFileSync(join(OUT, 'web-session-body.txt'), text, 'utf8')
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) writeFileSync(join(OUT, 'web-session.png'), Buffer.from(shot.result.data, 'base64'))
console.log(`final body chars: ${text.length}`)
console.log('--- body (tail) ---')
console.log(text.slice(-2500))
ws.close()
