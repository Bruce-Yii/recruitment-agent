import { openTab, evaluate, screenshot, sleep } from './cdp.mjs'

const url = process.argv[2]
const page = await openTab('ws://127.0.0.1:9222/devtools/browser/2d1f03c7-71ef-471f-aef0-234a1f67f2c9', url)
await sleep(3000)
console.log('TITLE:', await evaluate(page, 'document.title'))
console.log('URL:', await evaluate(page, 'location.href'))
console.log('BODY_TEXT_HEAD:', JSON.stringify(await evaluate(page, 'document.body.innerText.slice(0,1200)')))
console.log('INPUTS:', JSON.stringify(await evaluate(page, `Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).map(e=>({tag:e.tagName,type:e.type||'',ph:e.placeholder||'',ce:e.getAttribute('contenteditable'),cls:String(e.className).slice(0,60)}))`)))
console.log('BUTTONS:', JSON.stringify(await evaluate(page, `Array.from(document.querySelectorAll('button,[role="button"]')).slice(0,40).map(e=>({t:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,40),cls:String(e.className).slice(0,50)}))`)))
await screenshot(page, process.argv[3] ?? 'shot-00-landing.png')
console.log('SHOT saved')
process.exit(0)
