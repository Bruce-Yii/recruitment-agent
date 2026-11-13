// 极简 CDP 客户端：只够"在真浏览器里点一遍"用。
// 用 Node 24 自带的全局 WebSocket，不装 playwright/puppeteer（复用优先，不自研框架）。
import { writeFileSync } from 'node:fs'

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message ?? 'unknown'}`)), { once: true })
  })
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }
      }, 60000)
    })
  return { ws, send, close: () => ws.close() }
}

/** 新建一个标签页并连上它（不用 /json/new 的 GET 兼容问题：优先 Target.createTarget）。 */
export async function openTab(browserWsUrl, url) {
  const browser = await connect(browserWsUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  browser.close()
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const target = list.find((t) => t.id === targetId)
  if (!target) throw new Error('target not found')
  const page = await connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, 2500))
  return page
}

export async function evaluate(page, expression) {
  const res = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (res.exceptionDetails) {
    throw new Error(`eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
  }
  return res.result.value
}

export async function screenshot(page, filePath) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(filePath, Buffer.from(data, 'base64'))
  return filePath
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
