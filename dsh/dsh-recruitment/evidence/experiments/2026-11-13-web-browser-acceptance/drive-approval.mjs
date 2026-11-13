import { connect, evaluate, screenshot, sleep } from './cdp.mjs'

const prompt = process.argv[2]
const tag = process.argv[3] ?? 'run'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('49301'))
const page = await connect(t.webSocketDebuggerUrl)
await page.send('Runtime.enable')
await page.send('Page.enable')

const focused = await evaluate(page, `(() => {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) return 'NO_COMPOSER';
  el.focus();
  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
  return 'OK';
})()`)
console.log('FOCUS:', focused)
await sleep(400)
await screenshot(page, `${tag}-01-typed.png`)
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
console.log('SENT')

let shot = 0
for (let i = 0; i < 60; i++) {
  await sleep(3000)
  const body = await evaluate(page, 'document.body.innerText')
  const hit = /批准|允许|approval|Allow|需要你确认|human/i.test(body)
  if (i % 3 === 0) console.log(`[${i * 3}s] tail=...${body.replace(/\n+/g, ' | ').slice(-200)}`)
  if (hit) {
    shot++
    await screenshot(page, `${tag}-02-approval-${shot}.png`)
    console.log(`[${i * 3}s] APPROVAL_UI_HIT shot=${shot}`)
    if (shot >= 1) {
      console.log('=== BODY_TAIL ===')
      console.log(body.slice(-1800))
      break
    }
  }
}
await screenshot(page, `${tag}-03-final.png`)
process.exit(0)
