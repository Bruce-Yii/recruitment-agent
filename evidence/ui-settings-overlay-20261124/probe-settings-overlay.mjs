// UI 构建批次（2026-11-24）：1440 真机验证 #/settings 与队列不再叠影。
// 只读 DOM / 截图；不 import 产品代码；不写业务表。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPage, waitFor, evalIn, screenshot } from './cdp-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.UI_CHECK_PORT ?? 49348)
const CDP = Number(process.env.UI_CHECK_CDP ?? 9228)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = join(HERE, 'evidence')
mkdirSync(join(OUT, 'screenshots'), { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const result = { at: new Date().toISOString(), port: PORT, cdp: CDP, checks: {}, assertions: {}, errors: [], pass: false }
let page
try {
  const tokenPath = join(process.env.TEMP || '.', `ra-pr-host-${PORT}.token`)
  const token = readFileSync(tokenPath, 'utf8').trim()
  page = await openPage(CDP, 'about:blank', { width: 1440, height: 900 })

  await page.send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(token)}` })
  await waitFor(page, 'document.body && document.body.innerText.trim().length > 20', { timeoutMs: 30000 })
  await wait(1000)

  await page.send('Page.navigate', {
    url: `${BASE}/recruitment/test?as=recruiter&next=${encodeURIComponent('/recruitment/app#/settings')}`,
  })
  await waitFor(page, `!!document.querySelector('[data-testid="settings-page"]')`, { timeoutMs: 30000 })
  await wait(1800)

  result.checks.settings = await evalIn(page, `(() => {
    const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom }; };
    const settings = document.querySelector('[data-testid="settings-page"]');
    const canvas = document.querySelector('[data-testid="app-canvas"]');
    const head = document.querySelector('.canvas-head');
    const crumb = document.querySelector('.crumb-bar');
    const queue = document.querySelector('[data-testid="app-queue-view"]');
    const tabs = document.querySelector('[data-testid="app-queue-tabs"]');
    const sr = rect(settings), cr = rect(canvas), hr = rect(head);
    const inCanvas = !!(sr && cr && sr.x >= cr.x - 1 && sr.y >= cr.y - 1 && sr.x + sr.w <= cr.x + cr.w + 1 && sr.y + sr.h <= cr.y + cr.h + 1);
    const belowHead = sr && hr ? sr.y >= hr.y + hr.h - 1 : null;
    const headerContainsSettings = !!(head && head.querySelector('[data-testid="settings-page"]'));
    const topAtCenter = (() => {
      if (!sr) return null;
      const el = document.elementFromPoint(sr.x + sr.w / 2, sr.y + Math.min(sr.h / 2, 200));
      return el ? { tag: el.tagName, testid: el.closest('[data-testid]')?.getAttribute('data-testid') || null, cls: String(el.className || '').slice(0, 100) } : null;
    })();
    const styleProbe = (() => {
      const els = [document.querySelector('.canvas-col'), document.querySelector('.canvas-body'), settings];
      return els.map((el) => el ? { cls: String(el.className || ''), pos: getComputedStyle(el).position, z: getComputedStyle(el).zIndex, display: getComputedStyle(el).display } : null);
    })();
    return {
      url: location.href,
      viewport: [innerWidth, innerHeight],
      settingsExists: !!settings,
      settingsRect: sr,
      canvasRect: cr,
      headRect: hr,
      crumbText: (crumb?.innerText || '').trim().slice(0, 100),
      headerContainsSettings,
      queueViewExists: !!queue,
      queueTabsExists: !!tabs,
      settingsFullyInsideCanvas: inCanvas,
      settingsBelowHead: belowHead,
      topElementAtSettingsCenter: topAtCenter,
      styleProbe,
      bodyText: (document.body.innerText || '').slice(0, 1600),
    };
  })()`)
  await screenshot(page, join(OUT, 'screenshots', 'settings-1440.png'))

  await page.send('Page.navigate', { url: `${BASE}/recruitment/app#/queue` })
  await waitFor(page, `!!document.querySelector('[data-testid="app-queue-view"]')`, { timeoutMs: 30000 })
  await wait(1200)
  result.checks.queue = await evalIn(page, `(() => ({
    url: location.href,
    viewport: [innerWidth, innerHeight],
    queueViewExists: !!document.querySelector('[data-testid="app-queue-view"]'),
    settingsExists: !!document.querySelector('[data-testid="settings-page"]'),
    queueTabsExists: !!document.querySelector('[data-testid="app-queue-tabs"]'),
  }))()`)
  await screenshot(page, join(OUT, 'screenshots', 'queue-1440.png'))

  const s = result.checks.settings
  const q = result.checks.queue
  result.assertions = {
    viewport1440x900: Array.isArray(s.viewport) && s.viewport[0] === 1440 && s.viewport[1] === 900,
    settingsRendered: s.settingsExists === true,
    queueNotRenderedOnSettings: s.queueViewExists === false,
    queueTabsNotRenderedOnSettings: s.queueTabsExists === false,
    settingsInsideCanvas: s.settingsFullyInsideCanvas === true,
    settingsBelowCanvasHead: s.settingsBelowHead === true,
    headerDoesNotContainSettings: s.headerContainsSettings === false,
    settingsRouteHasNoOverlapCandidate: s.queueViewExists === false,
    queueRouteHasNoSettings: q.settingsExists === false,
    queueRouteRendersQueue: q.queueViewExists === true,
  }
  result.pass = Object.values(result.assertions).every(Boolean)
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
}
writeFileSync(join(OUT, 'probe-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  pass: result.pass,
  assertions: result.assertions,
  errors: result.errors,
  settings: result.checks.settings
    ? {
        viewport: result.checks.settings.viewport,
        settingsRect: result.checks.settings.settingsRect,
        canvasRect: result.checks.settings.canvasRect,
        headRect: result.checks.settings.headRect,
        queueViewExists: result.checks.settings.queueViewExists,
        settingsBelowHead: result.checks.settings.settingsBelowHead,
        settingsFullyInsideCanvas: result.checks.settings.settingsFullyInsideCanvas,
      }
    : null,
}, null, 2))


process.exit(result.pass ? 0 : 1)
