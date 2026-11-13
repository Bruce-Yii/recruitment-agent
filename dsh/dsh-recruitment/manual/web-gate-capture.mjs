// Web Gate 取证（第 2 步）：等当前 Web 会话跑完，抓页面正文 + 截图；然后刷新页面再抓一次。
// 用法：node manual/web-gate-capture.mjs <out-dir> <cdp-port>
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? '.'
const PORT = Number(process.argv[3] ?? 9558)
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
async function snapshot(tag) {
  const text = await evaluate('document.body.innerText')
  writeFileSync(join(OUT, `web-body-${tag}.txt`), text, 'utf8')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) writeFileSync(join(OUT, `web-page-${tag}.png`), Buffer.from(shot.result.data, 'base64'))
  return text
}
const markers = (text) => ({
  chars: text.length,
  skill: text.includes('recruitment-s6-s7'),
  report: text.includes('初筛') && (text.includes('待人工') || text.includes('需要人工')),
  next: text.includes('下一步'),
  structured: text.includes('结构化'),
  application: text.includes('申请'),
})

await send('Runtime.enable')
await send('Page.enable')

let text = ''
for (let attempt = 0; attempt < 100; attempt += 1) {
  await sleep(3000)
  text = await evaluate('document.body.innerText')
  const busy = await evaluate(`Boolean(document.querySelector('[aria-label="停止"],[aria-label="停止生成"],[data-busy="true"]'))`)
  const running = text.includes('进行中')
  if (attempt % 5 === 0) console.log(`  ${attempt * 3}s: chars=${text.length} busy=${busy} running=${running}`)
  if (!busy && !running && text.includes('初筛') && text.length > 1500) break
}
const before = await snapshot('before-refresh')
console.log('[before]', JSON.stringify(markers(before)))
await send('Page.reload', { ignoreCache: false })
console.log('reloaded; waiting…')
await sleep(6000)
const after = await snapshot('after-refresh')
console.log('[after ]', JSON.stringify(markers(after)))
const ok = markers(after).report && markers(after).next && markers(after).structured
console.log(`refresh persisted same result: ${ok}`)
if (!ok) process.exitCode = 1
ws.close()

