// 用 CDP 抓 DSH Web 页面的真实渲染（manual 验证 Web Gate 用；不是产品代码）。
// 用法：node manual/web-gate-cdp.mjs <out-dir> [cdp-port]
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? '.'
const PORT = Number(process.argv[3] ?? 9555)
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (page === undefined) throw new Error('no page target')
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

await send('Runtime.enable')
await send('Page.enable')

let text = ''
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(1000)
  const evaluated = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })
  text = evaluated.result?.result?.value ?? ''
  if (text.length > 300 && !text.includes('Loading')) break
}
writeFileSync(join(OUT, 'web-body.txt'), text, 'utf8')
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) writeFileSync(join(OUT, 'web-page.png'), Buffer.from(shot.result.data, 'base64'))
console.log(`title: ${page.title}`)
console.log(`url: ${page.url.replace(/token=[^&]+/, 'token=<redacted>')}`)
console.log(`body chars: ${text.length}`)
console.log('--- body (first 1200 chars) ---')
console.log(text.slice(0, 1200))
ws.close()

