// 用 CDP 在真实 DSH Web 页面里按可见文本 / aria-label 做**真实鼠标点击**
// （manual 验证 Web Gate 用；不是产品代码）。
//
// 用法：node manual/web-gate-click.mjs <out-dir> <cdp-port> "目标1|目标2|..."
//   目标可以是 aria-label（如 "添加工作区"）或可见文本（如 "继续"）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? '.'
const PORT = Number(process.argv[3] ?? 9555)
const SEQUENCE = (process.argv[4] ?? '').split('|').filter((item) => item !== '')
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
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text ?? 'evaluate failed')
  return response.result?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')

const findTarget = (needle) => `(() => {
  const needle = ${JSON.stringify(needle)};
  const byLabel = [...document.querySelectorAll('[aria-label]')].filter((el) => el.getAttribute('aria-label') === needle);
  const byButton = [...document.querySelectorAll('button')].filter((el) => (el.innerText || '').trim() === needle);
  const byText = [...document.querySelectorAll('button,a,li,div,span')]
    .filter((el) => (el.innerText || '').trim() === needle)
    .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
  const target = byLabel[0] ?? byButton[0] ?? byText[0];
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: target.tagName };
})()`

for (const needle of SEQUENCE) {
  const point = await evaluate(findTarget(needle))
  if (point === null) {
    console.log(`click ${JSON.stringify(needle)} -> NOT FOUND`)
    continue
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  console.log(`click ${JSON.stringify(needle)} -> ${point.tag} @ ${Math.round(point.x)},${Math.round(point.y)}`)
  await sleep(2000)
}

const text = await evaluate('document.body.innerText')
writeFileSync(join(OUT, 'web-body.txt'), text, 'utf8')
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) writeFileSync(join(OUT, 'web-page.png'), Buffer.from(shot.result.data, 'base64'))
console.log(`body chars: ${text.length}`)
console.log('--- body ---')
console.log(text.slice(0, 3000))
ws.close()


