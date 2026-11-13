import { connect, evaluate, screenshot, sleep } from './cdp.mjs'

const tag = process.argv[2] ?? 'refresh'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const t = list.find((x) => x.type === 'page' && x.url.includes('49301'))
const page = await connect(t.webSocketDebuggerUrl)
await page.send('Runtime.enable')
await page.send('Page.enable')

const before = await evaluate(page, 'location.href')
await page.send('Page.reload', { ignoreCache: true })
await sleep(6000)
const after = await evaluate(page, 'location.href')
const body = await evaluate(page, 'document.body.innerText')
console.log('BEFORE_URL:', before)
console.log('AFTER_URL:', after)
console.log('PERSISTED_TITLE:', body.includes('后端工程师'))
console.log('PERSISTED_TOOLCALL:', body.includes('recruitment_job_get') || body.includes('工具调用'))
console.log('PERSISTED_PROMPT:', body.includes('请只做一件事'))
await screenshot(page, `${tag}-03-after-reload.png`)
console.log('BODY_TAIL:', body.slice(-600).replace(/\n+/g, ' | '))
process.exit(0)
