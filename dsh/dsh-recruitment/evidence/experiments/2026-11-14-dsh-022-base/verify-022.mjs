// 在真浏览器里验证：0.2.2 底座 + 招聘插件，工具是否注册、模型是否通。
import { connect, evaluate, screenshot } from './cdp.mjs'

const url = process.argv[2]
const tag = process.argv[3] ?? 'v022'
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json()
const existing = list.find((x) => x.type === 'page' && x.url.includes('49303'))
let page
if (existing) {
  page = await connect(existing.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Page.navigate', { url })
} else {
  const b = await connect((await (await fetch('http://127.0.0.1:9223/json/version')).json()).webSocketDebuggerUrl)
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
  b.close()
  const l2 = await (await fetch('http://127.0.0.1:9223/json/list')).json()
  const t = l2.find((x) => x.id === targetId)
  page = await connect(t.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Page.navigate', { url })
}
await new Promise((r) => setTimeout(r, 8000))

// 关掉首次说明弹窗
const dismissed = await evaluate(page, `(() => { const b = Array.from(document.querySelectorAll('button')).find(e=>e.innerText.trim()==='继续'); if(b){b.click(); return 'DISMISSED'} return 'NO_MODAL' })()`)
console.log('INTRO:', dismissed)
await new Promise((r) => setTimeout(r, 1500))

const hasComposer = await evaluate(page, `!!document.querySelector('div[contenteditable="true"]')`)
console.log('COMPOSER:', hasComposer)
if (!hasComposer) {
  console.log('BODY:', (await evaluate(page, 'document.body.innerText')).slice(0, 600).replace(/\n+/g, ' | '))
  await screenshot(page, `${tag}-99-no-composer.png`)
  process.exit(2)
}

// 关键：旧会话钉住了旧 provider（no adapter registered for "opencode-go-openai-key2"），
// 必须开**新会话**才会用 profile 里的新默认模型。
const newSession = await evaluate(page, `(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find(e => (e.innerText||'').trim() === '新会话');
  if (!b) return 'NO_NEW_SESSION_BTN';
  b.click();
  return 'CLICKED';
})()`)
console.log('NEW_SESSION:', newSession)
await new Promise((r) => setTimeout(r, 3500))

const prompt = '请只做一件事：调用工具 recruitment_job_get，参数 job_id 为 792a10f9-6dd3-4d80-b141-6345880e2399。把 title 和 status 原样贴出来。不要做别的。'
await evaluate(page, `document.querySelector('div[contenteditable="true"]').focus()`)
await page.send('Input.insertText', { text: prompt })
await new Promise((r) => setTimeout(r, 600))
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
console.log('SENT')

let ok = false
for (let i = 0; i < 45; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const body = await evaluate(page, 'document.body.innerText')
  if (/后端工程师/.test(body)) {
    console.log(`RESULT_AT ${i * 3}s`)
    console.log('TAIL:', body.replace(/\n+/g, ' | ').slice(-420))
    ok = true
    break
  }
  if (i % 5 === 4) console.log(`[${i * 3}s] ...${body.replace(/\n+/g, ' | ').slice(-200)}`)
}
await screenshot(page, `${tag}-${ok ? '01-ok' : '02-fail'}.png`)
process.exit(ok ? 0 : 3)
