// Issue #92 P1-C G3 忠实度护栏 · 真实 DB 只读集成测试骨架。
//
// 前置（必须）：Owner（impl-g3）已在隔离库通过**产品真实写入路径**准备好数据——
//   1. scorecard.items 每个维度对象带 evidence[]（kind=SEGMENT，字段
//      transcript_artifact_id / transcript_revision / segment_id / quote）；
//   2. 对应 tenant 的 transcript_artifact / transcript_segment.content_text 里存在被逐字引用的 quote；
//   3. 已提交面评（SUBMITTED）以保证 primaryRate 非 null。
// 本测试**只负责读与断言**，绝不 insert/update 任何业务表。
//
// 环境变量（缺一不可；未设 G3_REAL_DB=1 时诚实 skip，不假绿）：
//   G3_REAL_DB=1
//   RECRUITMENT_TEST_DB_HOST / RECRUITMENT_TEST_DB_PORT / RECRUITMENT_TEST_DB_USER
//   RECRUITMENT_TEST_DB / RECRUITMENT_TEST_DB_PASSWORD / RECRUITMENT_TEST_TENANT_ID
// 可选：G3_REAL_DB_KNOWN_QUOTE（Owner 写入的已知 quote 原文，用于「响应不得泄漏」断言）。
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { readG3FunnelTelemetry } from '../../src/domain/eval-telemetry.ts'

const HOST = process.env.RECRUITMENT_TEST_DB_HOST
const PORT = process.env.RECRUITMENT_TEST_DB_PORT
const USER = process.env.RECRUITMENT_TEST_DB_USER
const DATABASE = process.env.RECRUITMENT_TEST_DB
const PASSWORD = process.env.RECRUITMENT_TEST_DB_PASSWORD
const TENANT_ID = process.env.RECRUITMENT_TEST_TENANT_ID
const KNOWN_QUOTE = process.env.G3_REAL_DB_KNOWN_QUOTE
const ENABLED = process.env.G3_REAL_DB === '1'

const HAS_ENV =
  ENABLED &&
  typeof HOST === 'string' && HOST !== '' &&
  typeof PORT === 'string' && PORT !== '' &&
  typeof USER === 'string' && USER !== '' &&
  typeof DATABASE === 'string' && DATABASE !== '' &&
  typeof PASSWORD === 'string' && PASSWORD !== '' &&
  typeof TENANT_ID === 'string' && TENANT_ID !== ''

// 诚实跳过：无 env 时不构造假数据、不假装通过。

test(
  'G3 真实库：readG3FunnelTelemetry 的 guardrailRate 与独立 SQL（strpos）一致，且响应不含 quote/UUID',
  { skip: HAS_ENV ? false : 'ACCEPTED skip, not a pass — G3 real DB env opt-in: G3_REAL_DB=1 + RECRUITMENT_TEST_DB_* / RECRUITMENT_TEST_TENANT_ID（前置：真实写入夹具）' },
  async () => {
    // 独立 pg.Pool（测试文件内直接 import pg 建池，不复用产品代码伪造 client）。
    const pool = new pg.Pool({
      host: HOST,
      port: Number(PORT),
      user: USER,
      database: DATABASE,
      password: PASSWORD,
      max: 2,
      application_name: 'dsh-recruitment-g3-telemetry-real-test',
    })
    try {
      const snapshot = await readG3FunnelTelemetry(pool as never, TENANT_ID as string)
      assert.equal(snapshot.degraded, false, '真实库查询不应降级')

      const guardrail = snapshot.paired_guardrails.find(
        (g) => g.id === 'scorecard_completion_vs_faithfulness',
      )
      assert.ok(guardrail !== undefined)
      assert.notEqual(
        guardrail.guardrailRate,
        null,
        'Owner 已准备引用样本，guardrailRate 必须是数值（null 说明写入或 SQL 没接上）',
      )

      // 独立实现：用 strpos 逐字匹配（与产品 SQL 不同的写法）重算命中率。
      // scorecard.items 结构：{ <dim>: { evidence: [{ kind, transcript_artifact_id,
      // transcript_revision, segment_id, quote }, ...] } }
      const independent = await pool.query<{ sampled: string; matched: string }>(
        `select
           count(*)::text as sampled,
           count(*) filter (
             where exists (
               select 1 from recruitment.transcript_segment ts
                where ts.tenant_id = sc.tenant_id
                  and ts.artifact_id = (ev->>'transcript_artifact_id')::uuid
                  and position(ev->>'quote' in ts.content_text) > 0
             )
           )::text as matched
         from recruitment.scorecard sc
         cross join lateral jsonb_each(sc.items) as dim(key, value)
         cross join lateral jsonb_array_elements(dim.value->'evidence') as ev
         where sc.tenant_id = $1::uuid
           and sc.status = 'SUBMITTED'
           and ev->>'kind' = 'SEGMENT'
           and ev ? 'quote'`,
        [TENANT_ID],
      )
      const sampled = Number(independent.rows[0]?.sampled ?? 0)
      const matched = Number(independent.rows[0]?.matched ?? 0)
      assert.ok(sampled > 0, 'Owner 夹具必须包含可抽样的 SEGMENT 引用')
      const expected = Number((matched / sampled).toFixed(4))
      assert.equal(
        guardrail.guardrailRate,
        expected,
        `guardrailRate 必须等于独立 SQL（strpos）重算值 ${expected}（${matched}/${sampled}）`,
      )

      // 响应不得泄漏引用原文或 UUID：把整个快照 JSON.stringify 后检查。
      const serialized = JSON.stringify(snapshot)
      if (typeof KNOWN_QUOTE === 'string' && KNOWN_QUOTE !== '') {
        assert.equal(
          serialized.includes(KNOWN_QUOTE),
          false,
          '响应 JSON 不得包含 quote 原文',
        )
      }
      const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      assert.equal(
        uuidPattern.test(serialized),
        false,
        '响应 JSON 不得包含 UUID（tenant/artifact/segment/quote 原文均不得出现）',
      )
    } finally {
      await pool.end()
    }
  },
)

