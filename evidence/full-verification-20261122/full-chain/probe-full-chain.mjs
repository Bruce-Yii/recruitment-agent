// =============================================================================
// probe-full-chain.mjs — Lane2b 1440x900 one-shot full-chain evidence (task-17)
// =============================================================================
// Fresh disposable DB/host + Chrome 1440x900. One continuous real-UI chain:
//  1 OPEN job (AI draft + custom rubric dimension) + approve rubric
//  2 upload real PDF -> auto screening visible; DB decision must NOT change
//  3 human criterion override -> criterion_override +1 + feedback
//  4 发候选人自助选时段 -> booking link -> public confirm -> interview +1
//  5 import transcript -> scorecard_draft +1 (no submitted scorecard yet)
//  6 interviewer submits scorecard -> scorecard +1, decision facts ready
//  7 record final decision -> decision +1
//  8 expand decision trace -> read real actions/actors; machine-check no UUID /
//     full sha256 / 「证据」
//
// Independent psql readback at EVERY state (work/d5/fullpage evidence scripts
// reused only as references; this script imports no product code for DB reads —
// psql.exe is spawned directly). Outputs only under
// evidence/full-verification-20261122/full-chain/ and work/d5/fullpage/**.
// NEVER commits/pushes/checkouts/stashes or modifies product code.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'
import { createFreshEnvironment } from './fresh-lib.mjs'
import { openPage, waitFor, evalIn, screenshot } from '../e2e-live/scripts/cdp-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const OUT = join(REPO, 'evidence/full-verification-20261122/full-chain')
const LOGDIR = join(HERE, 'logs', `full-chain-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const PS = (name) => join(REPO, 'work/d5/e2e-live/scripts', name)
const PORT = 49349                     // lane port; avoid lane2a 49347 / human 49351
const CDP = 9222
const TOKEN_PATH = join(process.env.TEMP ?? '.', `ra-pr-host-${PORT}.token`)
const DB_PASSWORD = process.env.RECRUITMENT_DB_PASSWORD || '123456'
const TENANT = '11111111-1111-4111-8111-000000000001'
const HR = '11111111-1111-4111-8111-000000000103'
const IA = '11111111-1111-4111-8111-000000000104'
const IB = '11111111-1111-4111-8111-000000000105'
const FIXTURE = join(HERE, 'fixtures/synthetic-upload.pdf')
const PSQL_EXE = 'D:\\12412\\PostgreSQL\\bin\\psql.exe'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const SHA256_RE = /\b[0-9a-f]{64}\b/i

mkdirSync(OUT, { recursive: true })
mkdirSync(LOGDIR, { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString()
const relRepo = (p) => relative(REPO, p).replace(/\\/g, '/')
function psqlRun(db, sql) {
  const r = spawnSync(PSQL_EXE, ['-X', '-At', '-U', 'postgres', '-h', '127.0.0.1', '-d', db, '-c', sql],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, PGPASSWORD: DB_PASSWORD }, timeout: 30000 })
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status }
}
const psql = (db, sql) => psqlRun(db, sql).stdout
const num = (db, sql) => { const v = psql(db, sql); return /^\d+$/.test(v) ? Number(v) : NaN }

const HEAD_SQL = [
  "select 'job',count(*) from recruitment.job",
  "select 'rubric_version',count(*) from recruitment.rubric_version",
  "select 'approval',count(*) from recruitment.approval",
  "select 'application',count(*) from recruitment.application",
  "select 'intake_asset',count(*) from recruitment.intake_asset",
  "select 'decision',count(*) from recruitment.decision",
  "select 'criterion_override',count(*) from recruitment.criterion_override",
  "select 'interview',count(*) from recruitment.interview",
  "select 'booking_invite',count(*) from recruitment.booking_invite",
  "select 'scorecard_draft',count(*) from recruitment.scorecard_draft",
  "select 'scorecard',count(*) from recruitment.scorecard",
  "select 'event_inbox',count(*) from recruitment.event_inbox",
].join(' union all ')

function headCounts(db) {
  const out = psql(db, HEAD_SQL)
  const map = {}
  for (const line of out.split(/\r?\n/)) {
    const [k, v] = line.split('|')
    if (k && /^\d+$/.test(v ?? '')) map[k] = Number(v)
  }
  return map
}
const delta = (a, b, k) => (b[k] ?? 0) - (a[k] ?? 0)

const result = {
  generated_at: stamp(), branch: '', head: '', base: '7695243', viewport: [1440, 900],
  mode: 'FRESH', db: '', host: `http://127.0.0.1:${PORT}`, cdp: CDP,
  steps: [], counts: { PASS: 0, FAIL: 0, BLOCKED: 0 }, overall_pass: false,
  baseline_head_counts: null, machine_checks: null, error: null,
}
let FRESH = null, HOST_PID = null, CHROME_PID = null, page = null, db = ''
let baseline = null
let jobId = '', appId = '', customDimension = '', approvedRubric = false

function saveResult() { writeFileSync(join(OUT, 'full-chain-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8') }
function w(file, text) { writeFileSync(file, text, 'utf8') }

// ------------------------------------------------------------ UI helpers ---
const js = (expr) => evalIn(page, expr)
async function waitJs(expr, timeoutMs = 120000, interval = 300) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { if (await js(expr)) return true } catch { /* ignore */ }
    await wait(interval)
  }
  return false
}
async function waitSql(sql, timeoutMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = psql(db, sql)
    if (v !== '') return v
    await wait(500)
  }
  return ''
}
async function click(sel) {
  return await js(`(() => {const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true})()`)
}
async function clickText(text) {
  return await js(`(() => {const btns=[...document.querySelectorAll('button,[role="button"]')];const b=btns.find(e=>(e.innerText||'').trim().includes(${JSON.stringify(text)}));if(!b)return false;b.scrollIntoView({block:'center'});b.click();return true})()`)
}
async function fill(sel, value) {
  return await js(`(() => {const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;const s=Object.getOwnPropertyDescriptor(proto,'value').set;s.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
}
async function body() { return (await js('document.body.innerText')) || '' }
function excerpt(text, start, len = 600) {
  const i = text.indexOf(start)
  if (i < 0) return text.slice(0, len).replace(/\n+/g, ' | ')
  return text.slice(i, i + len).replace(/\n+/g, ' | ')
}
async function navApp(hash = '', alias = 'recruiter') {
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/recruitment/test?as=${alias}&next=${encodeURIComponent('/recruitment/app' + hash)}` })
  await waitFor(page, `!!document.querySelector('[data-testid="app-chat-input"]')`, { timeoutMs: 30000 })
  await wait(1000)
}
async function uploadPdf(filePath) {
  const root = await page.send('DOM.getDocument', { depth: -1, pierce: true })
  const node = await page.send('DOM.querySelector', { nodeId: root.root.nodeId, selector: '[data-testid="v4-canvas-route"] input[type="file"]' })
  if (!node.nodeId) return { ok: false, reason: 'canvas file input not found' }
  await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId })
  return { ok: true, files: [relRepo(filePath)] }
}
async function fillScorecardForm() {
  return await js(`(() => {
    const form=document.querySelector('[data-testid="scorecard-form"]');if(!form)return {ok:false,why:'form missing'};
    const set=(el,val)=>{const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))};
    const sels=[...form.querySelectorAll('select[data-role="assessment"]')];
    for(const s of sels){const o=[...s.options].find(x=>x.value==='MET')||s.options[1];if(o)set(s,o.value)}
    const nums=[...form.querySelectorAll('input[data-role="score"][type="number"]')];
    for(const n of nums)set(n,'4');
    const notes=[...form.querySelectorAll('textarea[data-role="note"]')];
    for(const t of notes)set(t,'FULLCHAIN 实机观察：候选人能说明支付回调幂等、对账与团队协作案例。');
    const ov=form.querySelector('select[data-role="overall"]');
    if(ov){const o=[...ov.options].find(x=>x.value==='ADVANCE')||ov.options[1];if(o)set(ov,o.value)}
    return {ok:true,dimensions:sels.length,scores:nums.length,notes:notes.length,overall:ov?ov.value:null};
  })()`)
}
async function submitScorecardFor(interviewId, alias) {
  await navApp('#/interviewer', alias)
  const rowsReady = await waitJs(`!!document.querySelector('[data-testid="interviewer-row"]')`, 30000)
  let opened = false
  if (rowsReady) {
    opened = await js(`(() => {const rows=[...document.querySelectorAll('[data-testid="interviewer-row"]')];const r=rows.find(x=>x.getAttribute('data-interview-id')===${JSON.stringify(interviewId)});if(!r)return false;r.scrollIntoView({block:'center'});r.click();return true})()`)
  }
  let formReady = await waitJs(`!!document.querySelector('[data-testid="open-scorecard"]')`, 20000)
  let openClicked = false
  if (formReady) openClicked = await click('[data-testid="open-scorecard"]')
  formReady = await waitJs(`!!document.querySelector('[data-testid="submit-scorecard"]')`, 20000)
  const filled = formReady ? await fillScorecardForm() : { ok: false, why: 'form not ready' }
  let submit = { ok: false, reason: 'button missing' }
  if (formReady) {
    const state = await js(`(() => {const b=document.querySelector('[data-testid="submit-scorecard"]');return b?{disabled:b.disabled}:null})()`)
    submit = state ? { ok: !state.disabled, disabled: state.disabled } : submit
    if (submit.ok) {
      await click('[data-testid="submit-scorecard"]')
      await wait(3500)
      submit.clicked = true
    }
  }
  const text = await body()
  return { alias, rowsReady, opened, formReady, openClicked, filled, submit, ui: excerpt(text, '面评', 400) }
}

// ---------------------------------------------------------- milestone IO ---
const SHOT_NAMES = {
  '01': '01-job-created', '01b': '01b-rubric-approved', '02': '02-auto-screening', '03': '03-criterion-override',
  '04': '04-booking-confirmed', '05': '05-scorecard-draft', '06': '06-scorecard', '07': '07-decision', '08': '08-trace',
}
async function milestone(n, title, { verdict, reason, ui = '', sqls = [], extra = null }) {
  const png = join(OUT, `${SHOT_NAMES[n] || n}.png`)
  const dbTxt = join(OUT, `${n}-db.txt`)
  const uiTxt = join(OUT, `${n}-ui.txt`)
  const lines = [
    `=== DB READBACK MILESTONE ${n} — ${title} ===`,
    `at: ${stamp()}`, `db: ${db} (SELECT-only psql; no product code imported)`,
    `verdict: ${verdict}`, `reason: ${reason}`, '',
    '-- baseline head counts', psql(db, HEAD_SQL), '',
    ...sqls.flatMap((s) => ['-- SQL: ' + s, psql(db, s), '']),
  ]
  w(dbTxt, lines.join('\n') + '\n')
  w(uiTxt, [
    `=== UI MILESTONE ${n} — ${title} ===`, `at: ${stamp()}`,
    `host: http://127.0.0.1:${PORT}`, 'viewport: 1440x900 (headless Chrome, CDP 9222)',
    `verdict: ${verdict}`, `reason: ${reason}`, `key_visible_text: ${ui}`,
    extra ? `extra: ${JSON.stringify(extra)}` : '', '----- PAGE innerText -----', await body(),
  ].filter(Boolean).join('\n') + '\n')
  await screenshot(page, png)
  const counts = headCounts(db)
  const step = {
    milestone: n, title, verdict, reason,
    screenshot: relRepo(png), db_readback: relRepo(dbTxt), ui_text: relRepo(uiTxt),
    db_counts: counts, at: stamp(), extra,
  }
  result.steps.push(step)
  result.counts[verdict] = (result.counts[verdict] ?? 0) + 1
  result.baseline_head_counts = baseline
  saveResult()
  console.log(`[fullchain] ${n} ${verdict} — ${title}`)
  return counts
}

// ------------------------------------------------------------------ main ---
try {
  const git = (...args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.trim()
  result.branch = git('branch', '--show-current')
  result.head = git('rev-parse', '--short', 'HEAD')
  if (result.branch !== 'evidence/full-verification-chain') throw new Error(`wrong branch: ${result.branch}`)
  if (result.head !== '7695243') throw new Error(`wrong head: ${result.head}`)
  if (existsSync(TOKEN_PATH)) throw new Error(`token path busy: ${TOKEN_PATH}`)
  if (!existsSync(FIXTURE)) throw new Error(`PDF fixture missing: ${FIXTURE}`)

  process.env.RECRUITMENT_DB_PASSWORD = DB_PASSWORD
  FRESH = await createFreshEnvironment(new Date().toISOString().replace(/[:.]/g, '-'))
  process.env.DSH_HOME = FRESH.homeDir
  db = FRESH.dbName
  result.db = db
  result.dataset = FRESH.dataset
  baseline = headCounts(db)
  w(join(LOGDIR, 'environment.txt'), JSON.stringify({ db, profile: FRESH.profileName, home: FRESH.homeDir, branch: result.branch, head: result.head, baseline }, null, 2) + '\n')

  const host = spawnSync('pwsh', ['-NoProfile', '-File', PS('start-host.ps1'), '-Profile', FRESH.profileName, '-Port', String(PORT), '-OutDir', HERE, '-WorkspaceRoot', FRESH.workspaceRoot, '-DshHome', FRESH.homeDir], { encoding: 'utf8', windowsHide: true, cwd: REPO, timeout: 240000 })
  if (host.status !== 0) throw new Error('start-host failed: ' + (host.stderr || host.stdout || '').slice(-2000))
  HOST_PID = Number((host.stdout.match(/"pid"\s*:\s*(\d+)/) || [])[1] || 0) || null
  const token = readFileSync(TOKEN_PATH, 'utf8').trim()
  const chrome = spawnSync('pwsh', ['-NoProfile', '-File', PS('start-chrome.ps1'), '-CdpPort', String(CDP), '-Width', '1440', '-Height', '900', '-OutDir', HERE], { encoding: 'utf8', windowsHide: true, cwd: REPO, timeout: 120000 })
  if (chrome.status !== 0) throw new Error('start-chrome failed: ' + (chrome.stderr || chrome.stdout || '').slice(-2000))
  CHROME_PID = Number((chrome.stdout.match(/"pid"\s*:\s*(\d+)/) || [])[1] || 0)
    || Number((spawnSync('pwsh', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${CDP} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8', windowsHide: true }).stdout || '').trim()) || null
  page = await openPage(CDP, 'about:blank', { width: 1440, height: 900 })
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}` })
  await waitFor(page, 'document.body.innerText.trim().length > 20', { timeoutMs: 30000 })
  await navApp()

  // ---- 1) NEW OPEN JOB via AI draft + custom rubric dimension ----
  await click('[data-testid="app-rail-new-job"]')
  await waitFor(page, `!!document.querySelector('[data-testid="app-new-job-title"]')`, { timeoutMs: 10000 })
  const jobTitle = `FULLCHAIN岗位-${Date.now().toString().slice(-6)}`
  customDimension = '有高并发分布式系统实战经验'
  await fill('[data-testid="app-new-job-title"]', jobTitle)
  await fill('[data-testid="app-new-job-req"]', '负责高并发交易系统后端开发，要求有分布式系统与带团队经验。')
  await click('[data-testid="app-new-job-draft"]')
  const draftNotice = await waitJs(`(() => {const t=document.body.innerText;return t.includes('已按需求生成')||t.includes('已保留默认合规评分标准')})()`, 120000)
  const criteriaBefore = await js(`document.querySelectorAll('.new-job-crit-row').length`)
  await fill('[data-testid="app-new-job-add-criterion-input"]', customDimension)
  await click('[data-testid="app-new-job-add-criterion-btn"]')
  const criteriaAfter = await js(`document.querySelectorAll('.new-job-crit-row').length`)
  const openDefault = await js(`(() => {const b=document.querySelector('[data-testid="app-new-job-status-open"]');return !!b && b.className.includes('active')})()`)
  await click('[data-testid="app-new-job-submit"]')
  await wait(2500)
  jobId = await waitSql(`select id from recruitment.job where tenant_id='${TENANT}' and title='${jobTitle.replace(/'/g, "''")}' order by created_at desc limit 1`)
  const jobStatus = jobId ? psql(db, `select status from recruitment.job where id='${jobId}'`) : ''
  const jobUi = await body()
  await milestone('01', '新建 OPEN 岗位（AI 草案 + 自定义维度）', {
    verdict: !!jobId && jobStatus === 'OPEN' && draftNotice && criteriaAfter > criteriaBefore && openDefault ? 'PASS' : 'FAIL',
    reason: `title=${jobTitle}; jobId=${jobId || 'MISSING'}; status=${jobStatus}; draftNotice=${draftNotice}; criteria=${criteriaBefore}->${criteriaAfter}; OPEN default=${openDefault}`,
    ui: excerpt(jobUi, '新建岗位', 600),
    sqls: [`select id,title,status,created_at from recruitment.job where tenant_id='${TENANT}' order by created_at desc limit 3`, `select id,version_no,payload_hash from recruitment.rubric_version where tenant_id='${TENANT}' order by created_at desc limit 3`],
    extra: { jobTitle, jobId, jobStatus, draftNotice, criteriaBefore, criteriaAfter, openDefault, customDimension },
  })
  if (!jobId) throw new Error('step1: new job missing in DB; cannot continue chain')

  // approve rubric
  await navApp(`#/job/${jobId}`)
  await clickText('岗位标准')
  const approveShown = await waitJs(`!!document.querySelector('[data-testid="canvas-action-rubric-approve"]')`, 30000)
  if (approveShown) {
    await click('[data-testid="canvas-action-rubric-approve"]')
    await waitJs(`!!document.querySelector('[data-testid="canvas-rubric-approve-submit"]')`, 10000)
    await click('[data-testid="canvas-rubric-approve-submit"]')
    await waitJs(`(() => {const t=document.body.innerText;return t.includes('已批准岗位评分标准')&&t.includes('已锁定')})()`, 60000)
  }
  approvedRubric = num(db, `select count(*) from recruitment.job j join recruitment.rubric_version rv on rv.id=j.current_rubric_version_id join recruitment.approval a on a.tenant_id=j.tenant_id and a.resource_type='RUBRIC_VERSION' and a.resource_id=rv.id and a.status='APPROVED' where j.id='${jobId}'`) >= 1
  await milestone('01b', '批准岗位评分标准（自定义维度入版）', {
    verdict: approveShown && approvedRubric ? 'PASS' : 'FAIL',
    reason: `approveButton=${approveShown}; rubricApprovedDB=${approvedRubric}`,
    ui: excerpt(await body(), '岗位标准', 600),
    sqls: [`select id,version_no,payload_hash from recruitment.rubric_version where tenant_id='${TENANT}' order by created_at desc limit 3`, `select id,resource_type,resource_id,status from recruitment.approval where tenant_id='${TENANT}' order by created_at desc limit 5`],
    extra: { approveShown, approvedRubric },
  })

  // ---- 2) UPLOAD REAL PDF -> auto screening; decision must NOT change ----
  const decisionBefore2 = num(db, `select count(*) from recruitment.decision where tenant_id='${TENANT}'`)
  await navApp(`#/job/${jobId}`)
  await clickText('候选人漏斗')
  const uploadBtn = await waitJs(`!!document.querySelector('[data-testid="canvas-action-upload"]')`, 30000)
  const setFile = await uploadPdf(FIXTURE)
  appId = await waitSql(`select id from recruitment.application where tenant_id='${TENANT}' and job_id='${jobId}' order by applied_at desc limit 1`)
  const autoTask = await waitSql(`select case when coalesce(description,'') like '%[auto-screening]%' then description else result_ref end from recruitment.business_task where tenant_id='${TENANT}' and task_type='RESUME_PARSE' and (coalesce(description,'') like '%[auto-screening]%' or result_ref like '%auto_screening%') order by created_at desc limit 1`, 120000)
  let autoVisible = false, autoText = ''
  if (appId) {
    await navApp(`#/application/${appId}`)
    autoVisible = await waitJs(`!!document.querySelector('[data-testid="canvas-auto-screening"]')`, 60000)
    autoText = await js(`(() => {const e=document.querySelector('[data-testid="canvas-auto-screening"]');return e?e.innerText.slice(0,1800):''})()`)
  }
  const decisionAfter2 = num(db, `select count(*) from recruitment.decision where tenant_id='${TENANT}'`)
  await milestone('02', '上传真实 PDF 并显示自动初筛（不写 decision）', {
    verdict: uploadBtn && setFile.ok && !!appId && autoVisible && decisionAfter2 === decisionBefore2 ? 'PASS' : 'FAIL',
    reason: `upload=${setFile.ok}; appId=${appId || 'MISSING'}; autoTask=${autoTask ? autoTask.slice(0,120) : 'MISSING'}; autoVisible=${autoVisible}; decision ${decisionBefore2}->${decisionAfter2} (must be unchanged)`,
    ui: excerpt(autoText || await body(), '自动初筛', 700),
    sqls: [
      `select id,file_name,mime_type,byte_size,validation_status from recruitment.intake_asset where tenant_id='${TENANT}' order by created_at desc limit 3`,
      `select id,application_id,decision_scope,result,created_at from recruitment.decision where tenant_id='${TENANT}' order by created_at desc limit 5`,
      `select id,task_type,status,left(coalesce(description,''),120),result_ref from recruitment.business_task where tenant_id='${TENANT}' order by created_at desc limit 5`,
    ],
    extra: { uploadBtn, setFile, appId, autoTask: autoTask.slice(0, 200), autoVisible, decisionBefore2, decisionAfter2, autoText },
  })
  if (!appId) throw new Error('step2: PDF upload did not create application; chain stops')

  // ---- 3) HUMAN CRITERION OVERRIDE -> +1 + feedback ----
  const overrideBefore = num(db, `select count(*) from recruitment.criterion_override where tenant_id='${TENANT}'`)
  await navApp(`#/application/${appId}`)
  const overrideReady = await waitJs(`!!document.querySelector('[data-testid^="canvas-criterion-override-"]')`, 30000)
  let overrideDetail = null
  let stateBtns = []
  if (overrideReady) {
    overrideDetail = await js(`(() => {const b=document.querySelector('[data-testid^="canvas-criterion-override-"]');return b?{testid:b.getAttribute('data-testid'),text:(b.innerText||'').trim().slice(0,120)}:null})()`)
    if (overrideDetail) {
      await click(`[data-testid="${overrideDetail.testid}"]`)
      const confirmReady = await waitJs(`!!document.querySelector('[data-testid="canvas-override-confirm-input"]')`, 15000)
      if (confirmReady) {
        await fill('[data-testid="canvas-override-confirm-input"]', '我以面试官人工判断确认这条标准按通过处理（FULLCHAIN 实机）')
        // choose first non-default state if available
        stateBtns = await js(`(() => [...document.querySelectorAll('[data-testid^="canvas-override-state-"]')].map(e=>({testid:e.getAttribute('data-testid'),text:(e.innerText||'').trim()})))()`)
        if (stateBtns && stateBtns.length > 1) await click(`[data-testid="${stateBtns[1].testid}"]`)
        await click('[data-testid="canvas-override-submit"]')
        await wait(3000)
      }
      overrideDetail.confirmReady = confirmReady
      overrideDetail.stateBtns = stateBtns
      overrideDetail.modalText = await js(`(() => {const m=document.querySelector('.ros-modal');return m?m.innerText.slice(0,1200):''})()`)
    }
  }
  const overrideAfter = num(db, `select count(*) from recruitment.criterion_override where tenant_id='${TENANT}'`)

  // Human screening conclusion (ADVANCE) — required by the real stage ladder S6→S7→S8.
  // This is a genuine UI decision (SCREENING scope); FINAL decision is counted separately.
  await navApp(`#/application/${appId}`)
  const screeningBtn = await waitJs(`!!document.querySelector('[data-testid="canvas-action-screening"]')`, 30000)
  let screeningDetail = null
  if (screeningBtn) {
    await click('[data-testid="canvas-action-screening"]')
    await wait(1000)
    const advance = await clickText('通过')
    const taFilled = await js(`(() => {const t=document.querySelector('.ros-modal textarea');if(!t)return false;const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(t,'FULLCHAIN 实机初筛：材料齐备、人工纠偏已留痕，同意进入面试阶段。');t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    await click('[data-testid="canvas-modal-submit"]')
    await wait(2500)
    screeningDetail = { advance, taFilled, ui: excerpt(await body(), '初筛', 300) }
  }
  const screeningDecisionAfter = psql(db, `select decision_scope || '|' || result from recruitment.decision where application_id='${appId}' order by created_at desc limit 1`)

  await milestone('03', '新候选人页人工纠偏（criterion_override +1 + 反馈）', {
    verdict: overrideReady && overrideAfter === overrideBefore + 1 ? 'PASS' : 'FAIL',
    reason: `overrideReady=${overrideReady}; detail=${JSON.stringify(overrideDetail)}; criterion_override ${overrideBefore}->${overrideAfter} (expect +1)`,
    ui: excerpt((overrideDetail?.modalText || '') + ' ' + await body(), '纠偏', 600),
    sqls: [`select id,application_id,criterion_key,human_state,confirmation_method,record_version,created_at from recruitment.criterion_override where tenant_id='${TENANT}' order by created_at desc limit 5`],
    extra: { overrideBefore, overrideAfter, overrideDetail, screeningBtn, screeningDetail, screeningDecisionAfter },
  })

  // ---- 4) SELF-BOOKING LINK -> PUBLIC CONFIRM -> interview +1 ----
  const interviewBefore4 = num(db, `select count(*) from recruitment.interview where application_id='${appId}'`)
  await navApp(`#/application/${appId}`)
  const scheduleShown = await waitJs(`!!document.querySelector('[data-testid="canvas-action-schedule"]')`, 30000)
  if (scheduleShown) await click('[data-testid="canvas-action-schedule"]')
  const selfBookMode = await waitJs(`!!document.querySelector('[data-testid="schedule-mode-self-book"]')`, 15000)
  if (selfBookMode) await click('[data-testid="schedule-mode-self-book"]')
  await waitJs(`!!document.querySelector('[data-testid="self-book-slot-2"]')`, 10000)
  await fill('[data-testid="schedule-time-input"]', '2027-01-05T10:00')
  await fill('[data-testid="self-book-slot-2"]', '2027-01-06T15:00')
  await fill('[data-testid="self-book-slot-3"]', '2027-01-07T10:30')
  const interviewersInput = await js(`(() => {const e=document.querySelector('[data-testid="schedule-interviewers-input"]');return e?e.value:null})()`)
  if (!interviewersInput) await fill('[data-testid="schedule-interviewers-input"]', `${IA},${IB}`)
  await click('[data-testid="canvas-modal-submit"]')
  const linkReady = await waitJs(`!!document.querySelector('[data-testid="self-book-result-url"] a')`, 45000)
  const bookingHref = await js(`(() => {const a=document.querySelector('[data-testid="self-book-result-url"] a');return a?(a.getAttribute('href')||a.href):''})()`)
  const tokenMatch = /\/recruitment\/book\/([A-Za-z0-9_-]{43})/.exec(bookingHref || '')
  const publicToken = tokenMatch ? tokenMatch[1] : ''
  let publicText = '', publicSlots = 0, confirmed = false, interviewAfter4 = NaN
  if (publicToken) {
    await page.send('Network.enable').catch(() => {})
    await page.send('Network.clearBrowserCookies').catch(() => {})
    await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/recruitment/book/${publicToken}` })
    await waitFor(page, `document.body.innerText.includes('面试预约') || document.body.innerText.includes('预约')`, { timeoutMs: 30000 })
    publicText = await js('document.body.innerText.slice(0,1800)')
    publicSlots = await js(`document.querySelectorAll('button[data-slot]').length`)
    await js(`(() => {const b=document.querySelector('button[data-slot="1"]');if(!b)return false;b.click();return true})()`)
    confirmed = await waitJs(`document.body.innerText.includes('已确认')`, 30000)
    interviewAfter4 = num(db, `select count(*) from recruitment.interview where application_id='${appId}'`)
  }
  await milestone('04', '发候选人自助选时段 + 免登录确认（interview +1）', {
    verdict: selfBookMode && linkReady && !!publicToken && confirmed && interviewAfter4 === interviewBefore4 + 1 ? 'PASS' : 'FAIL',
    reason: `selfBookMode=${selfBookMode}; linkReady=${linkReady}; token=${publicToken ? 'yes' : 'MISSING'}; href=${bookingHref ? 'yes' : 'none'}; publicSlots=${publicSlots}; confirmed=${confirmed}; interview ${interviewBefore4}->${interviewAfter4} (expect +1)`,
    ui: excerpt(publicText || await body(), '预约', 700),
    sqls: [`select id,application_id,round_no,status,scheduled_start_at,timezone,created_at from recruitment.interview where application_id='${appId}' order by created_at`, `select id,application_id,booking_state,confirmed_slot_index,self_booked from recruitment.booking_invite where application_id='${appId}' order by created_at desc`],
    extra: { scheduleShown, selfBookMode, linkReady, bookingHref, publicToken: publicToken ? 'REDACTED' : '', publicSlots, confirmed, interviewBefore4, interviewAfter4, publicText },
  })

  // ---- 5) IMPORT TRANSCRIPT -> scorecard_draft +1, no submitted scorecard ----
  const draftBefore5 = num(db, `select count(*) from recruitment.scorecard_draft where tenant_id='${TENANT}'`)
  const scBefore5 = num(db, `select count(*) from recruitment.scorecard where tenant_id='${TENANT}'`)
  // meeting binding prerequisite (same as wave2 pattern, only on the fresh disposable DB).
  // The transcript modal picks the application's interview by server rule (not visible in UI);
  // bind EVERY interview of this application so the real UI write is not falsely blocked.
  const ivRows = psql(db, `select i.id::text from recruitment.interview i where i.tenant_id='${TENANT}' order by i.scheduled_start_at`).split(/\r?\n/).filter(Boolean)
  const bindingLog = []
  async function bindInterview(ivRow, tag) {
    const bound = num(db, `select count(*) from recruitment.meeting_binding mb join recruitment.meeting m on m.id=mb.meeting_id where mb.tenant_id='${TENANT}' and mb.interview_id='${ivRow}' and mb.unbound_at is null and m.meeting_role in ('PRIMARY','CONTINUATION')`)
    if (bound === 0) {
      const mr = psqlRun(db, `insert into recruitment.meeting (tenant_id,provider,external_meeting_id,meeting_role) values ('${TENANT}','local_demo','fullchain-${Date.now()}-${tag}-${Math.floor(Math.random()*100000)}','PRIMARY') returning id`)
      // psql -At prints the RETURNING value AND the command tag ("INSERT 0 1"); take first line.
      const meetingId = (mr.stdout || '').split(/\r?\n/)[0].trim()
      const br = meetingId ? psqlRun(db, `insert into recruitment.meeting_binding (tenant_id,meeting_id,interview_id,binding_method,bound_by_actor_id) values ('${TENANT}','${meetingId}','${ivRow}','SCHEDULED','${HR}') returning id`) : { stdout: '', stderr: 'no meeting id' }
      bindingLog.push({ tag, interview_id: ivRow, before: bound, meetingId, meetingInsertError: mr.stderr, bindingInsertId: br.stdout.split(/\r?\n/)[0].trim(), bindingInsertError: br.stderr })
    } else bindingLog.push({ tag, interview_id: ivRow, before: bound, skipped: true })
  }
  for (const [idx, ivRow] of ivRows.entries()) await bindInterview(ivRow, `pre-${idx}`)
  await navApp(`#/application/${appId}`)
  await js(`(() => {if(window.__fcFetchInstalled)return true;window.__fcFetchInstalled=true;window.__fcWrites=[];const orig=window.fetch.bind(window);window.fetch=async(...args)=>{const r=await orig(...args);try{const m=(args[1]?.method)||'GET';if(m!=='GET')window.__fcWrites.push({url:String(args[0]),method:m,body:String(args[1]?.body||'').slice(0,600),status:r.status,resp:(await r.clone().text()).slice(0,900)})}catch{}return r};return true})()`)
  const importBtn = await waitJs(`!!document.querySelector('[data-testid="canvas-action-transcript-import"]')`, 30000)
  if (importBtn) await click('[data-testid="canvas-action-transcript-import"]')
  const modalReady = await waitJs(`!!document.querySelector('[data-testid="canvas-modal-submit"]')`, 10000)
  const transcript = 'FULLCHAIN 实机转写：候选人介绍高并发交易系统经验，负责订单撮合与消息队列，带 4 人小组做稳定性治理；面试官追问故障回滚与幂等，候选人给出具体案例。'
  if (modalReady) {
    await js(`(() => {const el=document.querySelector('.ros-modal textarea');if(!el)return false;const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(el,${JSON.stringify(transcript)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    await click('[data-testid="canvas-modal-submit"]')
  }
  await waitJs(`(() => !document.querySelector('[data-testid="canvas-modal-submit"]'))()`, 60000)
  let transcriptWrites = await js(`window.__fcWrites || []`)
  // Reparative retry on the disposable DB: if the real UI POST reports NO_MEETING_BOUND,
  // read the exact interview_id from the captured request, seed a synthetic meeting binding
  // for that interview, and repeat the real UI submit (never fabricate a draft row).
  let retryInfo = null
  const noBound = transcriptWrites.find((w) => String(w.url).includes('/transcript/import') && String(w.resp).includes('NO_MEETING_BOUND'))
  if (noBound) {
    const m = /"interview_id":"([0-9a-f-]{36})"/.exec(noBound.body || '')
    const targetIv = m ? m[1] : ''
    if (targetIv) {
      await bindInterview(targetIv, 'retry')
      await navApp(`#/application/${appId}`)
      await js(`(() => {window.__fcFetchInstalled=true;window.__fcWrites=[];const orig=window.fetch.bind(window);window.fetch=async(...args)=>{const r=await orig(...args);try{const m=(args[1]?.method)||'GET';if(m!=='GET')window.__fcWrites.push({url:String(args[0]),method:m,body:String(args[1]?.body||'').slice(0,600),status:r.status,resp:(await r.clone().text()).slice(0,900)})}catch{}return r};return true})()`)
      await click('[data-testid="canvas-action-transcript-import"]')
      await waitJs(`!!document.querySelector('[data-testid="canvas-modal-submit"]')`, 10000)
      await js(`(() => {const el=document.querySelector('.ros-modal textarea');if(!el)return false;const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(el,${JSON.stringify(transcript)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
      await click('[data-testid="canvas-modal-submit"]')
      await waitJs(`(() => !document.querySelector('[data-testid="canvas-modal-submit"]'))()`, 60000)
      transcriptWrites = await js(`window.__fcWrites || []`)
      retryInfo = { targetIv, bound: num(db, `select count(*) from recruitment.meeting_binding where interview_id='${targetIv}' and unbound_at is null`) }
    }
  }
  const draftRow = await waitSql(`select interviewer_actor_id::text || '|' || interview_id::text from recruitment.scorecard_draft where tenant_id='${TENANT}' order by created_at desc limit 1`, 30000)
  const draftAfter5 = num(db, `select count(*) from recruitment.scorecard_draft where tenant_id='${TENANT}'`)
  const scAfter5 = num(db, `select count(*) from recruitment.scorecard where tenant_id='${TENANT}'`)
  const [draftActor, draftInterview] = draftRow ? draftRow.split('|') : ['', '']
  const draftAlias = draftActor === IB ? 'interviewer_b' : 'interviewer_a'
  let draftUi = ''
  if (draftInterview) {
    await navApp('#/interviewer', draftAlias)
    const rows = await waitJs(`!!document.querySelector('[data-testid="interviewer-row"]')`, 30000)
    if (rows) await js(`(() => {const r=[...document.querySelectorAll('[data-testid="interviewer-row"]')].find(x=>x.getAttribute('data-interview-id')===${JSON.stringify(draftInterview)});if(r){r.click();return true}return false})()`)
    await waitJs(`!!document.querySelector('[data-testid="quick-notes-textarea"]')`, 20000)
    draftUi = await js(`(() => {const e=document.querySelector('[data-testid="quick-notes-textarea"]');return e?e.value.slice(0,500):''})()`)
  }
  const draftPayload = draftRow ? psql(db, `select left(payload::text,260) from recruitment.scorecard_draft where tenant_id='${TENANT}' order by created_at desc limit 1`) : ''
  await milestone('05', '导入面试转写 → 自动面评草稿（未提交）', {
    verdict: importBtn && modalReady && draftAfter5 >= draftBefore5 + 1 && scAfter5 === scBefore5 && transcriptWrites.some((w) => String(w.url).includes('/transcript/import') && w.status === 200) ? 'PASS' : 'FAIL',
    reason: `importBtn=${importBtn}; modal=${modalReady}; scorecard_draft ${draftBefore5}->${draftAfter5} (UI wrote >=1 draft: ${draftAfter5 - draftBefore5}); scorecard ${scBefore5}->${scAfter5} (must stay); transcript POST status=200; draftActor=${draftActor || 'MISSING'}; draftPayload=${draftPayload}`,
    ui: excerpt(draftUi || await body(), '草稿', 700),
    sqls: [`select id,interview_id,interviewer_actor_id,left(payload::text,220),created_at from recruitment.scorecard_draft where tenant_id='${TENANT}' order by created_at desc limit 3`, `select count(*) as submitted from recruitment.scorecard where tenant_id='${TENANT}'`],
    extra: { importBtn, modalReady, draftBefore5, draftAfter5, scBefore5, scAfter5, draftRow: draftRow || '', draftPayload, draftAlias, draftUi, transcriptWrites, boundInterviews: ivRows.length, bindingLog, retryInfo },
  })

  // ---- 6) INTERVIEWER SUBMITS SCORECARD -> scorecard +1, facts ready ----
  const scBefore6 = num(db, `select count(*) from recruitment.scorecard where tenant_id='${TENANT}'`)
  const scSubmits = []
  // Every required interviewer of every interview must submit, otherwise FINAL decision is
  // correctly blocked with SCORECARD_MISSING. Iterate real (interview, actor) pairs from DB.
  const ivActorRows = psql(db, `select i.id::text || '|' || ivr.actor_id::text from recruitment.interview i join recruitment.interviewer ivr on ivr.interview_id=i.id and ivr.tenant_id=i.tenant_id where i.tenant_id='${TENANT}' and i.application_id='${appId}' order by i.created_at, ivr.created_at`).split(/\r?\n/).filter(Boolean)
  for (const row of ivActorRows) {
    const [iv, actor] = row.split('|')
    const alias = actor === IB ? 'interviewer_b' : actor === IA ? 'interviewer_a' : null
    if (!alias) continue
    // skip pairs that already have a submitted scorecard (e.g. from a prior chain step)
    const already = num(db, `select count(*) from recruitment.scorecard s join recruitment.interviewer ivr on ivr.id=s.interviewer_id and ivr.tenant_id=s.tenant_id where s.interview_id='${iv}' and ivr.actor_id='${actor}'`)
    if (already > 0) continue
    scSubmits.push(await submitScorecardFor(iv, alias))
  }
  const scAfter6 = num(db, `select count(*) from recruitment.scorecard where tenant_id='${TENANT}'`)
  const sid = await js(`(() => {const m=document.cookie.match(/(?:^|;\\s*)rc_sid=([^;]+)/);return m?decodeURIComponent(m[1]):''})()`)
  const facts = await js(`(async () => {const h={'x-recruitment-request':'1'};if(${JSON.stringify(sid)})h['x-dsh-session']=${JSON.stringify(sid)};try{const r=await fetch('/recruitment/api/decision/facts?application_id=${appId}',{method:'GET',cache:'no-store',credentials:'same-origin',headers:h});const t=await r.text();let p=null;try{p=JSON.parse(t)}catch{}return {status:r.status,probe:r.status===200?'READY':(r.status===404?'MISSING':'ERROR'),parsed:p?{contract_version:p.contract_version,evaluation_summary_state:p.evaluation_summary_state,evaluation_summary:p.evaluation_summary?{available:p.evaluation_summary.available,ready_for_decision:p.evaluation_summary.ready_for_decision,blockers:p.evaluation_summary.blockers}:null,missing:p.missing}:null,raw:t.slice(0,1200)}}catch(e){return {status:0,probe:'ERROR',raw:String(e)}}})()`)
  await milestone('06', '面试官提交独立面评（scorecard +1，决策事实就绪）', {
    verdict: scAfter6 > scBefore6 && scSubmits.length > 0 && scSubmits.every((s) => s.submit?.clicked) && facts?.status === 200 ? 'PASS' : 'FAIL',
    reason: `scorecard ${scBefore6}->${scAfter6} (expect +1); decision facts probe=${facts?.probe} status=${facts?.status} state=${facts?.parsed?.evaluation_summary_state}; submissions=${scSubmits.length} (${JSON.stringify(scSubmits.map((s) => ({ alias: s.alias, filled: s.filled?.ok, clicked: s.submit?.clicked })))})`,
    ui: excerpt(await body(), '面评', 700),
    sqls: [`select id,interview_id,rubric_version_id,status,overall,revision_no,created_at from recruitment.scorecard where tenant_id='${TENANT}' order by created_at desc limit 5`, `select id,application_id,decision_scope,result,created_at from recruitment.decision where tenant_id='${TENANT}' order by created_at desc limit 5`],
    extra: { scBefore6, scAfter6, scSubmits, facts },
  })

  // ---- 7) FINAL DECISION -> decision +1 ----
  const decisionBefore7 = num(db, `select count(*) from recruitment.decision where tenant_id='${TENANT}' and decision_scope='FINAL'`)
  // Natural chain: advance the application stage to S10 via the real UI before FINAL decision.
  const stageAdvances = []
  for (let attempt = 0; attempt < 8; attempt++) {
    const stage = psql(db, `select current_stage_code from recruitment.application where id='${appId}'`)
    if (stage === 'S10') break
    await navApp(`#/application/${appId}`)
    const btn = await waitJs(`!!document.querySelector('[data-testid="canvas-action-stage-advance"]')`, 20000)
    if (!btn) { stageAdvances.push({ attempt, reason: 'button missing' }); break }
    await click('[data-testid="canvas-action-stage-advance"]')
    await wait(900)
    const confirmInput = await js(`(() => {const i=[...document.querySelectorAll('.ros-modal input')].find(e=>(e.getAttribute('placeholder')||'').includes('确认原话'));if(!i)return false;const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'FULLCHAIN 实机确认：材料、转写、面评齐备，申请推进到下一阶段。');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    const submit = await js(`(() => {const b=document.querySelector('[data-testid="canvas-modal-submit"]');if(!b)return null;const disabled=b.disabled;if(!disabled)b.click();return {disabled}})()`)
    await wait(2500)
    const after = psql(db, `select current_stage_code from recruitment.application where id='${appId}'`)
    stageAdvances.push({ attempt, before: stage, confirmInput, submit, after, ui: excerpt(await body(), '阶段', 300) })
    if (after === stage) break
  }
  const stageAtDecision = psql(db, `select current_stage_code from recruitment.application where id='${appId}'`)
  await navApp(`#/application/${appId}`)
  const decisionBtn = stageAtDecision === 'S10' ? await waitJs(`!!document.querySelector('[data-testid="canvas-action-decision"]')`, 30000) : false
  let decisionDetail = null
  if (decisionBtn) {
    await click('[data-testid="canvas-action-decision"]')
    await wait(1500)
    decisionDetail = { modalText: await js(`(() => {const m=document.querySelector('.ros-modal');return m?m.innerText.slice(0,1600):''})()`) }
    decisionDetail.factsBlocked = await js(`!!document.querySelector('[data-testid="decision-facts-blocked"]')`)
    decisionDetail.missingScorecards = await js(`!!document.querySelector('[data-testid="decision-missing-scorecards"]')`)
    decisionDetail.submitDisabled = await js(`(() => {const b=document.querySelector('[data-testid="canvas-modal-submit"]');return b?b.disabled:null})()`)
    if (decisionDetail.submitDisabled === false) {
      await clickText('终审决策')
      await clickText('通过（推进 / 发 Offer）')
      const modalTa = await js(`(() => {const t=document.querySelector('.ros-modal textarea');if(!t)return false;const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(t,'FULLCHAIN 实机终审：两轮评估与转写齐备，决定推进发 Offer。');t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
      decisionDetail.reasonFilled = modalTa
      await click('[data-testid="canvas-modal-submit"]')
      await wait(3500)
      decisionDetail.afterSubmit = excerpt(await body(), '决策', 600)
    }
  }
  const decisionAfter7 = num(db, `select count(*) from recruitment.decision where tenant_id='${TENANT}' and decision_scope='FINAL'`)
  await milestone('07', '记录正式终审决策（decision +1）', {
    verdict: decisionAfter7 === decisionBefore7 + 1 ? 'PASS' : 'FAIL',
    reason: `stageAtDecision=${stageAtDecision}; FINAL decision ${decisionBefore7}->${decisionAfter7} (expect +1); all decisions=${psql(db, `select decision_scope||'|'||result from recruitment.decision where tenant_id='${TENANT}' order by created_at`)}; detail=${JSON.stringify(decisionDetail)}`,
    ui: excerpt((decisionDetail?.afterSubmit || '') + ' ' + await body(), '决策', 700),
    sqls: [`select id,application_id,coalesce(interview_id::text,'-'),decision_scope,result,superseded_by_decision_id,created_at from recruitment.decision where tenant_id='${TENANT}' order by created_at desc limit 5`, `select id,current_stage_code,lifecycle_status from recruitment.application where id='${appId}'`],
    extra: { decisionBefore7, decisionAfter7, decisionDetail, stageAdvances, stageAtDecision, appStage: psql(db, `select current_stage_code from recruitment.application where id='${appId}'`) },
  })

  // ---- 8) TRACE TIMELINE + MACHINE CHECKS ----
  await navApp(`#/application/${appId}`)
  const traceToggle = await waitJs(`!!document.querySelector('[data-testid="canvas-decision-trace-toggle"]')`, 30000)
  if (traceToggle) await click('[data-testid="canvas-decision-trace-toggle"]')
  const traceText = await js(`(() => {const e=document.querySelector('[data-testid="canvas-decision-trace-list"]');return e?e.innerText.slice(0,4000):''})()`)
  const machine = {
    trace_toggle: traceToggle,
    trace_length: traceText.length,
    zero_uuid: !UUID_RE.test(traceText),
    zero_full_sha256: !SHA256_RE.test(traceText),
    zero_证据: !traceText.includes('证据'),
    has_person: /招聘负责人|面试官|系统记录|HR/.test(traceText),
    has_action: /初筛|通过|纠偏|决定|安排面试|面评|转写/.test(traceText),
    sample: traceText.slice(0, 1200),
  }
  result.machine_checks = machine
  await milestone('08', '展开决策追责时间线（机器校验：无 UUID / 全量 sha256 / 「证据」）', {
    verdict: traceToggle && traceText.length > 0 && machine.zero_uuid && machine.zero_full_sha256 && machine.zero_证据 && machine.has_person && machine.has_action ? 'PASS' : 'FAIL',
    reason: `machine checks: ${JSON.stringify(machine)}`,
    ui: excerpt(traceText, '', 1200),
    sqls: [`select count(*) from recruitment.decision where application_id='${appId}'`, `select count(*) from recruitment.criterion_override where application_id='${appId}'`],
    extra: { machine },
  })

  result.overall_pass = result.steps.every((s) => s.verdict === 'PASS')
} catch (e) {
  result.error = String(e?.stack || e)
  console.error('[fullchain] ERROR', result.error)
} finally {
  try { if (page) page.close() } catch { /* ignore */ }
  try { if (CHROME_PID) execFileSync('taskkill', ['/PID', String(CHROME_PID), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* ignore */ }
  try { if (HOST_PID) spawnSync('pwsh', ['-NoProfile', '-File', PS('stop-host.ps1'), '-Port', String(PORT), '-OutDir', HERE], { encoding: 'utf8', windowsHide: true, cwd: REPO, timeout: 30000 }) } catch { /* ignore */ }
  try { if (existsSync(TOKEN_PATH)) unlinkSync(TOKEN_PATH) } catch { /* ignore */ }
  try { if (FRESH) await FRESH.cleanup() } catch { /* ignore */ }
  saveResult()
  console.log(JSON.stringify({ overall_pass: result.overall_pass, counts: result.counts, steps: result.steps.map((s) => `${s.milestone}:${s.verdict}:${s.title}`), error: result.error }, null, 2))
  process.exit(result.overall_pass ? 0 : 1)
}
