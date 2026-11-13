// S8 负例（验收 #4）：真实 SQLSTATE 与工具层拒绝。
//
// 四个探针，全部在**回滚事务**里跑，不污染 ra_s6s7：
//   NEG1 工具：缺面试官                 → INVALID_ARGS(INTERVIEWER_REQUIRED)，且零写入
//   NEG2 工具：同一会议绑第二场面试     → MEETING_ALREADY_BOUND，且零写入（需先有一场带会议的面试）
//   NEG3 裸 SQL：同一 meeting 第二条 active binding → 23505 / uq_meeting_binding_active
//   NEG4 裸 SQL：非法 stage_code         → 23503 / fk_interview_stage_catalog（0006 的外键）
//
// 用法（在 dsh/dsh-recruitment 下）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/interview-line/negatives.mjs [--application <uuid>]
import pg from 'pg'

import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { scheduleInTransaction } from '../../src/tools/interview-schedule.ts'

const password = process.env.RECRUITMENT_DB_PASSWORD
if (!password) {
  console.error('FATAL: RECRUITMENT_DB_PASSWORD is not set')
  process.exit(2)
}

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR = '11111111-1111-4111-8111-000000000103'
const INTERVIEWER = '11111111-1111-4111-8111-000000000104'
const argv = process.argv.slice(2)
const at = argv.indexOf('--application')
const applicationId = at >= 0 && argv[at + 1] !== undefined
  ? argv[at + 1]
  : '11111111-1111-4111-8111-000000000701'

const { resolved: config } = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  tenant_id: TENANT, actor_id: HR,
}, { RECRUITMENT_DB_PASSWORD: password })
if (config === null) {
  console.error('FATAL: 测试库配置解析失败')
  process.exit(2)
}

const pool = new pg.Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres', password, database: 'ra_s6s7', max: 2,
})

const results = []
function pass(name, detail) {
  results.push({ name, ok: true, detail })
  console.log(`[PASS] ${name} — ${detail}`)
}
function fail(name, detail) {
  results.push({ name, ok: false, detail })
  console.log(`[FAIL] ${name} — ${detail}`)
}

/** 在回滚事务里跑 fn；把 expect 抛出的错误原样交给调用方。 */
async function inRolledBackTx(fn) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR])
    try {
      return { ok: true, value: await fn(client) }
    } catch (error) {
      return { ok: false, error }
    }
  } finally {
    try { await client.query('rollback') } catch { /* 保留第一个错误 */ }
    client.release()
  }
}

/** 把工具错误拆成 code/reason_code（消息形如 `CODE: {json}`）。 */
function errorBody(error) {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  try {
    return JSON.parse(index >= 0 ? message.slice(index + 2) : message)
  } catch {
    return { raw: message }
  }
}

async function countInterviews(client) {
  const { rows } = await client.query('select count(*)::int as n from recruitment.interview')
  return rows[0].n
}

function baseArgs(slot, extra = {}) {
  const start = new Date(Date.now() + 7 * 24 * 3600 * 1000)
  start.setUTCHours(6, 0, 0, 0)   // 14:00 +08:00
  return {
    intent: 'CREATE',
    idempotency_key: `neg:${slot}`,
    application_id: applicationId,
    round_no: 9,
    slot_code: slot,
    interviewers: [{ actor_id: INTERVIEWER }],
    scheduled_start_at: start.toISOString(),
    duration_minutes: 60,
    ...extra,
  }
}

try {
  // ---- NEG1 缺面试官 ----
  {
    const slot = `NEG1${Date.now().toString(36).toUpperCase()}`
    const outcome = await inRolledBackTx(async (client) => {
      const before = await countInterviews(client)
      try {
        await scheduleInTransaction(client, config, baseArgs(slot, { interviewers: [] }))
        return { threw: false, before }
      } catch (error) {
        const after = await countInterviews(client)
        return { threw: true, body: errorBody(error), before, after }
      }
    })
    if (!outcome.ok) {
      fail('NEG1 缺面试官', `事务意外失败：${outcome.error}`)
    } else {
      const { threw, body, before, after } = outcome.value
      const ok = threw && body.code === 'INVALID_ARGS' && body.reason_code === 'INTERVIEWER_REQUIRED' && before === after
      const detail = `code=${body.code} reason_code=${body.reason_code} interview_rows ${before}→${after}`
      ok ? pass('NEG1 缺面试官被拒且零写入', detail) : fail('NEG1 缺面试官', detail)
    }
  }

  // ---- NEG2 同一会议绑第二场（工具层） ----
  {
    const { rows } = await pool.query(
      `select m.id as meeting_id, m.provider, m.external_meeting_id, b.interview_id
         from recruitment.meeting_binding b
         join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
        where b.unbound_at is null
          and b.tenant_id = $1
          and m.external_meeting_id is not null
        order by b.bound_at desc
        limit 1`, [TENANT])
    const meeting = rows[0]
    if (meeting === undefined) {
      console.log('[N/A]  NEG2 当前库没有"已绑定的外部会议"，先跑一次成功 CREATE 再来')
    } else {
      const slot = `NEG2${Date.now().toString(36).toUpperCase()}`
      const outcome = await inRolledBackTx(async (client) => {
        const before = await countInterviews(client)
        try {
          await scheduleInTransaction(client, config, baseArgs(slot, {
            meeting: { provider: meeting.provider, external_meeting_id: meeting.external_meeting_id },
          }))
          return { threw: false, before }
        } catch (error) {
          const after = await countInterviews(client)
          return { threw: true, body: errorBody(error), before, after }
        }
      })
      if (!outcome.ok) {
        fail('NEG2 同一会议绑第二场', `事务意外失败：${outcome.error}`)
      } else {
        const { threw, body, before, after } = outcome.value
        const ok = threw && body.code === 'MEETING_ALREADY_BOUND' && before === after
        const detail = `code=${body.code} reason_code=${body.reason_code ?? '-'} interview_rows ${before}→${after}`
        ok ? pass('NEG2 同一会议绑第二场被拒且零写入', detail) : fail('NEG2 同一会议绑第二场', detail)
      }
    }
  }

  // ---- NEG3 裸 SQL：同一 meeting 第二条 active binding → 23505 ----
  {
    const { rows } = await pool.query(
      `select b.meeting_id, b.interview_id
         from recruitment.meeting_binding b
        where b.unbound_at is null and b.tenant_id = $1
        order by b.bound_at desc limit 1`, [TENANT])
    const binding = rows[0]
    const outcome = await inRolledBackTx(async (client) => {
      const { rows: apps } = await client.query(
        'select application_id from recruitment.interview where id = $1', [binding.interview_id])
      const appId = apps[0]?.application_id ?? applicationId
      const slot = `NEG3${Date.now().toString(36).toUpperCase()}`
      const { rows: created } = await client.query(
        `insert into recruitment.interview
           (tenant_id, application_id, round_no, slot_code, stage_code, status,
            scheduled_start_at, scheduled_end_at, status_changed_by_actor_id)
         values ($1, $2, 9, $3, 'S8', 'SCHEDULED', now() + interval '7 days',
                 now() + interval '7 days' + interval '60 minutes', $4)
         returning id`, [TENANT, appId, slot, HR])
      try {
        await client.query(
          `insert into recruitment.meeting_binding
             (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
           values ($1, $2, $3, 'SCHEDULED', $4)`,
          [TENANT, binding.meeting_id, created[0].id, HR])
        return { threw: false }
      } catch (error) {
        return { threw: true, error }
      }
    })
    if (!outcome.ok || !outcome.value.threw) {
      fail('NEG3 第二条 active binding', `期望 23505，实际：${outcome.ok ? '插入成功' : outcome.error}`)
    } else {
      const error = outcome.value.error
      const ok = error.code === '23505' && error.constraint === 'uq_meeting_binding_active'
      const detail = `SQLSTATE=${error.code} constraint=${error.constraint}`
      ok ? pass('NEG3 第二条 active binding 被库拒绝', detail) : fail('NEG3 第二条 active binding', detail)
    }
  }

  // ---- NEG4 裸 SQL：非法 stage_code → 23503 ----
  {
    const outcome = await inRolledBackTx(async (client) => {
      const slot = `NEG4${Date.now().toString(36).toUpperCase()}`
      try {
        await client.query(
          `insert into recruitment.interview
             (tenant_id, application_id, round_no, slot_code, stage_code, status,
              scheduled_start_at, scheduled_end_at, status_changed_by_actor_id)
           values ($1, $2, 9, $3, 'S99', 'SCHEDULED', now() + interval '7 days',
                   now() + interval '7 days' + interval '60 minutes', $4)`,
          [TENANT, applicationId, slot, HR])
        return { threw: false }
      } catch (error) {
        return { threw: true, error }
      }
    })
    if (!outcome.ok || !outcome.value.threw) {
      fail('NEG4 非法 stage_code', `期望 23503，实际：${outcome.ok ? '插入成功' : outcome.error}`)
    } else {
      const error = outcome.value.error
      const ok = error.code === '23503' && error.constraint === 'fk_interview_stage_catalog'
      const detail = `SQLSTATE=${error.code} constraint=${error.constraint}`
      ok ? pass('NEG4 非法 stage_code 被外键拒绝', detail) : fail('NEG4 非法 stage_code', detail)
    }
  }
} finally {
  await pool.end()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n=== negatives: pass=${results.length - failed.length} fail=${failed.length} ===`)
process.exitCode = failed.length === 0 ? 0 : 1
