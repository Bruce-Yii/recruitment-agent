import { connect, evaluate, screenshot, sleep } from './cdp.mjs'

const prompt = process.argv[2]
const tag = process.argv[3] ?? 'run'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('49301'))
const page = await connect(t.webSocketDebuggerUrl)
await page.send('Runtime.enable')
await page.send('Page.enable')

// 1) 聚焦输入框并写入（contenteditable，用 execCommand 才能触发框架的 input 事件）
const focused = await evaluate(page, `(() => {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) return 'NO_COMPOSER';
  el.focus();
  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
  return 'OK:' + el.innerText.slice(0, 40);
})()`)
console.log('FOCUS:', focused)
await sleep(500)
await screenshot(page, `${tag}-01-typed.png`)

// 2) 回车发送
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
console.log('SENT')

// 3) 轮询等待模型回合（最多 240s）
let last = ''
let seen = false
for (let i = 0; i < 80; i++) {
  await sleep(3000)
  const body = await evaluate(page, 'document.body.innerText')
  if (body !== last) {
    last = body
    const tail = body.replace(/\n+/g, ' | ').slice(-260)
    console.log(`[${i * 3}s] ...${tail}`)
  }
  if (/recruitment_job_get/.test(body)) seen = true
  const done = /后端工程师/.test(body) && seen
  const idle = await evaluate(page, `(() => {
    const stop = document.querySelector('[data-testid="stop"], button[aria-label*="停止"], button[aria-label*="stop"]');
    return stop ? 'RUNNING' : 'IDLE';
  })()`)
  if (done && idle === 'IDLE') break
}
await screenshot(page, `${tag}-02-result.png`)
const body = await evaluate(page, 'document.body.innerText')
console.log('=== HAS_TOOL_NAME:', /recruitment_job_get/.test(body))
console.log('=== BODY_TAIL ===')
console.log(body.slice(-3000))
process.exit(0)
