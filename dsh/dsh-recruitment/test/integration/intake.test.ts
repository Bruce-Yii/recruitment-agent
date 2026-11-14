// S6 intake 的集成矩阵（**连真库** ra_s6s7，每个用例结束回滚）。
//
// 守的是四条：幂等（同一 sha256+job 不出第二条 application）、身份只认 phone/email、
// 读不出就拒绝且一行不写、"第一次归一化就写规范形"（IR-N5）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { observeIdentity, type StrongId } from '../../src/db/identity.ts'
import { intakeInTransaction, type IntakeMaterial } from '../../src/tools/application-intake.ts'
import { createApplicationIntakeTool } from '../../src/tools/application-intake.ts'
import { resolveConverterConfig } from '../../src/tools/converter.ts'
import { hex64, inRolledBackTx, one, seedScenario, testDatabaseConfig, createTestPool, TENANT, DEMO_JOB, uniqueSuffix } from './db.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

interface MaterialOptions {
  readonly sha?: string
  readonly phone?: { state?: string; value?: string; provenance?: string }
  readonly email?: { state?: string; value?: string; provenance?: string }
  readonly eligible?: string[]
  readonly completeness?: string
  readonly chars?: number
  readonly issues?: { code: string }[]
  readonly jobId?: string
}

/** 造一份可落库的材料（不读 PDF：身份结论只看 fields 的三态与来源）。 */
function makeMaterial(options: MaterialOptions = {}): IntakeMaterial {
  const evidence = [{ page: 1, bbox: [72, 100, 500, 120], block: 1, text: '联系我' }]
  const fields: Record<string, unknown> = {
    name: { state: 'present', value: '测试候选人', provenance: 'native_text', evidence },
    phone: {
      state: options.phone?.state ?? 'absent',
      provenance: options.phone?.provenance ?? 'native_text',
      evidence: (options.phone?.state ?? 'absent') === 'present' ? evidence : [],
      ...(options.phone?.value === undefined ? {} : { value: options.phone.value }),
    },
    email: {
      state: options.email?.state ?? 'absent',
      provenance: options.email?.provenance ?? 'native_text',
      evidence: (options.email?.state ?? 'absent') === 'present' ? evidence : [],
      ...(options.email?.value === undefined ? {} : { value: options.email.value }),
    },
    work_experience: { state: 'present', provenance: 'native_text', evidence },
    education: { state: 'absent', provenance: 'native_text', evidence: [] },
  }
  const eligible = options.eligible ?? ['phone', 'email']
  const observation = observeIdentity(fields as never, eligible)
  const output = {
    text: 'x'.repeat(options.chars ?? 1200),
    chars: options.chars ?? 1200,
    completeness: options.completeness ?? 'complete',
    issues: options.issues ?? [],
    fields,
    timeline: { covered_months_closed: 74, open_ended_intervals: 0, year_only_intervals: 0 },
    screening: { eligible_fields: eligible, identity_merge_eligible: eligible },
    meta: { pages: 1, source_sha256: options.sha ?? hex64('material'), backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  }
  return {
    real_path: 'C:/fake/resume.pdf',
    file_name: 'resume.pdf',
    byte_size: 2048,
    output: output as IntakeMaterial['output'],
    strong: observation.strong as StrongId[],
    blocked: observation.blocked,
    sha256: options.sha ?? hex64('material'),
  }
}

async function count(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: string }>(sql, [...params])
  return Number(rows[0]?.n ?? '0')
}

test('幂等：同一 (sha256, job_id) 第二次调用返回同一 application 且 created=false', async () => {
  await inRolledBackTx(pool, async (client) => {
    const material = makeMaterial({ phone: { state: 'present', value: '13900001111' } })
    const first = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.equal(first.created, true)
    assert.equal(first.candidate_created, true)
    assert.equal(first.matched_by, 'created')
    assert.equal(first.application.stage_code, 'S6')
    assert.equal(first.provenance, 'FIXTURE')
    assert.equal(first.labels.event_provider, 'internal')

    const second = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.equal(second.created, false)
    assert.equal(second.idempotent_replay, true)
    assert.equal(second.application_id, first.application_id)
    assert.equal(second.candidate_id, first.candidate_id)
    assert.equal(second.resume_version_id, first.resume_version_id)
    assert.equal(second.event_id, first.event_id, '同一材料的内部事件只记一条')

    // 库里确实只有一条 application
    const apps = await count(client, 'select count(*) as n from recruitment.application where job_id = $1 and resume_version_id = $2', [
      DEMO_JOB, first.resume_version_id,
    ])
    assert.equal(apps, 1)
  })
})

test('IR-N5：新建候选人时写的是规范形，不是来料原样', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 联系方式必须**每次现造**：`candidate` 上有 (tenant_id, normalized_phone/email) 的
    // 部分唯一索引，连同 "已有档案就复用" 的身份规则 —— 用固定字面量时，只要库里有
    // 别人的一条同号码/同邮箱的行（例如一次真实 headless 接入），这条用例就会命中它，
    // 断言 `matched_by='created'` 立刻变成假阴性。真实事故：2026-11-13 库里多了一条
    // `zhang.san@example.com`。
    const suffix = uniqueSuffix()
    const tail = String(1000 + (Number.parseInt(hex64(`irn5-${suffix}`).slice(0, 6), 16) % 9000))
    const rawPhone = `+86 139-0000-${tail}`
    const rawEmail = `Zhang.San.${suffix}@Example.COM`
    const material = makeMaterial({
      phone: { state: 'present', value: rawPhone },
      email: { state: 'present', value: rawEmail },
    })
    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    const { rows } = await client.query<{ normalized_phone: string; normalized_email: string; display_name: string; identity_status: string }>(
      'select normalized_phone, normalized_email, display_name, identity_status from recruitment.candidate where id = $1',
      [value.candidate_id],
    )
    assert.equal(rows[0]?.normalized_phone, `+861390000${tail}`)
    assert.equal(rows[0]?.normalized_email, rawEmail.trim().toLowerCase())
    assert.equal(rows[0]?.identity_status, 'ACTIVE')
    assert.equal(rows[0]?.display_name, '测试候选人')
    assert.equal(value.matched_by, 'created')
    assert.deepEqual(value.identity.strong_ids, ['email', 'phone'])
  })
})

test('关联 ≠ 合并：强标识命中已有档案 → 复用 candidate、新建 application、不写 candidate_merge', async () => {
  await inRolledBackTx(pool, async (client) => {
    const existing = await one(client, `insert into recruitment.candidate
        (tenant_id, display_name, normalized_phone, identity_status)
        values ($1, '原有候选人', '+8613900003333', 'ACTIVE') returning id`, [TENANT])

    const material = makeMaterial({ phone: { state: 'present', value: '13900003333' } })
    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.equal(value.candidate_id, existing)
    assert.equal(value.candidate_created, false)
    assert.equal(value.matched_by, 'phone')
    assert.equal(value.created, true)
    const merges = await count(client, 'select count(*) as n from recruitment.candidate_merge where tenant_id = $1', [TENANT])
    assert.equal(merges, 0, '关联不是合并：不得写 candidate_merge')
  })
})

test('跨字段交叉命中不同档案 → 拒绝 MULTIPLE_STRONG_MATCH，不合并、不写申请', async () => {
  await inRolledBackTx(pool, async (client) => {
    await one(client, `insert into recruitment.candidate
        (tenant_id, display_name, normalized_phone, identity_status)
        values ($1, 'A', '+8613900004444', 'ACTIVE') returning id`, [TENANT])
    await one(client, `insert into recruitment.candidate
        (tenant_id, display_name, normalized_email, identity_status)
        values ($1, 'B', 'b@example.test', 'ACTIVE') returning id`, [TENANT])
    const before = await count(client, 'select count(*) as n from recruitment.application where tenant_id = $1', [TENANT])
    const material = makeMaterial({
      phone: { state: 'present', value: '13900004444' },
      email: { state: 'present', value: 'b@example.test' },
    })
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      assert.match((error as Error).message, /MULTIPLE_STRONG_MATCH/)
      return true
    })
    const after = await count(client, 'select count(*) as n from recruitment.application where tenant_id = $1', [TENANT])
    assert.equal(after, before, '拒绝时一行都不写')
  })
})

test('身份红线：phone/email 都读不出 → MATERIAL_ATTRIBUTION_UNKNOWN，且**一行不写**', async () => {
  await inRolledBackTx(pool, async (client) => {
    const tables = [
      'recruitment.candidate', 'recruitment.application', 'recruitment.resume',
      'recruitment.resume_version', 'recruitment.intake_record', 'recruitment.intake_asset',
    ] as const
    const before = await Promise.all(tables.map((t) => count(client, `select count(*) as n from ${t} where tenant_id = $1`, [TENANT])))

    const material = makeMaterial({
      phone: { state: 'unreadable' },
      email: { state: 'absent' },
    })
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      const message = (error as Error).message
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      assert.match(message, /MATERIAL_ATTRIBUTION_UNKNOWN/)
      const json = JSON.parse(message.slice(message.indexOf(': ') + 2)) as { detail: { blocking_items: unknown[] } }
      assert.equal(json.detail.blocking_items.length, 1, 'blocking_items 不得为空')
      return true
    })
    const after = await Promise.all(tables.map((t) => count(client, `select count(*) as n from ${t} where tenant_id = $1`, [TENANT])))
    assert.deepEqual(after, before, '读不出时不判新人：不得落任何行')
  })
})

test('IR-N4：只有无国际前缀的裸号码 → REGION_AMBIGUOUS_PHONE（不得当强标识）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const material = makeMaterial({ phone: { state: 'present', value: '01088886666' } })
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      assert.match((error as Error).message, /REGION_AMBIGUOUS_PHONE/)
      return true
    })
  })
})

test('IR-G2：OCR 来源的手机号命中已有档案也不自动 → MATERIAL_ATTRIBUTION_UNKNOWN', async () => {
  await inRolledBackTx(pool, async (client) => {
    await one(client, `insert into recruitment.candidate
        (tenant_id, display_name, normalized_phone, identity_status)
        values ($1, '档案', '+8613900005555', 'ACTIVE') returning id`, [TENANT])
    const material = makeMaterial({ phone: { state: 'present', value: '13900005555', provenance: 'ocr_title' } })
    assert.deepEqual(material.strong, [], 'OCR 字段不得进强标识集')
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      assert.match((error as Error).message, /MATERIAL_ATTRIBUTION_UNKNOWN/)
      return true
    })
  })
})

test('IR-G6：平台噪声字段（converter 未列进 identity_merge_eligible）不得作标识', async () => {
  await inRolledBackTx(pool, async (client) => {
    const material = makeMaterial({ phone: { state: 'present', value: '13900006666' }, eligible: [] })
    assert.deepEqual(material.strong, [])
    await assert.rejects(intakeInTransaction(client, cfg, material, DEMO_JOB), (error: unknown) => {
      assert.match((error as Error).message, /MATERIAL_ATTRIBUTION_UNKNOWN/)
      return true
    })
  })
})

test('resolve(candidate)：命中已合并档案 → 挂到存活档，不写 MERGED 档', async () => {
  await inRolledBackTx(pool, async (client) => {
    const survivor = await one(client, `insert into recruitment.candidate
        (tenant_id, display_name, normalized_phone, identity_status)
        values ($1, '存活档', '+8613900007777', 'ACTIVE') returning id`, [TENANT])
    const merged = await one(client, `insert into recruitment.candidate
        (tenant_id, display_name, normalized_phone, identity_status)
        values ($1, '被合并档', '+8613900008888', 'ACTIVE') returning id`, [TENANT])
    // 合并（T2 的库层动作：插一行 candidate_merge，触发器把被合并方标 MERGED）
    await client.query(`insert into recruitment.candidate_merge
        (tenant_id, surviving_candidate_id, merged_candidate_id, match_basis,
         auto_merged, decided_by_actor_id)
        values ($1, $2, $3, $4::jsonb, false, $5)`, [
      TENANT, survivor, merged,
      JSON.stringify({ schema: 'identity/1', rule: 'MANUAL_CONFIRM', decided_via: 'HUMAN', strong_ids: ['phone'], confidence: { band: 'HIGH' } }),
      cfg.actor_id,
    ])
    const material = makeMaterial({ phone: { state: 'present', value: '13900008888' } })
    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.equal(value.candidate_id, survivor, '必须挂到存活档')
    assert.equal(value.candidate_created, false)
    const apps = await count(client, 'select count(*) as n from recruitment.application where candidate_id = $1', [merged])
    assert.equal(apps, 0, 'IR-F11：不得对 MERGED 档写新申请')
  })
})

test('parse_status 映射：complete→PARSED；partial→PARTIAL；0 字→FAILED（且 parse_error 非空）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const parsed = await intakeInTransaction(client, cfg, makeMaterial({ sha: hex64('m9001'), phone: { state: 'present', value: '13900009001' } }), DEMO_JOB)
    assert.equal(parsed.source.parse_status, 'PARSED')
    const partial = await intakeInTransaction(client, cfg, makeMaterial({
      sha: hex64('m9002'),
      phone: { state: 'present', value: '13900009002' }, completeness: 'partial', issues: [{ code: 'unverified_pdf_image' }],
    }), DEMO_JOB)
    assert.equal(partial.source.parse_status, 'PARTIAL')
    const failed = await intakeInTransaction(client, cfg, makeMaterial({
      sha: hex64('m9003'),
      phone: { state: 'present', value: '13900009003' }, chars: 0, issues: [{ code: 'pdf_no_text' }],
    }), DEMO_JOB)
    assert.equal(failed.source.parse_status, 'FAILED')
    const { rows } = await client.query<{ parse_status: string; parse_error: string | null }>(
      'select parse_status, parse_error from recruitment.resume_version where id = $1', [failed.resume_version_id],
    )
    assert.equal(rows[0]?.parse_status, 'FAILED')
    assert.ok((rows[0]?.parse_error ?? '').length > 0, 'ck_resume_version_error 要求 parse_error 非空')
  })
})

test('provenance 三维：LOCAL_FILE + internal 事件 ⇒ FIXTURE/MANUAL/CONNECTED（不冒充 LIVE）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const value = await intakeInTransaction(client, cfg, makeMaterial({ sha: hex64('m9004'), phone: { state: 'present', value: '13900009004' } }), DEMO_JOB)
    assert.deepEqual(value.labels, {
      provenance: 'FIXTURE',
      trigger: 'MANUAL',
      connection: 'CONNECTED',
      source_kind: 'LOCAL_FILE',
      event_provider: 'internal',
    })
    assert.equal(value.provenance, 'FIXTURE')
  })
})

test('配置里的 actor 不属于该租户 → FORBIDDEN(ACTOR_NOT_IN_TENANT)，不写库', async () => {
  await inRolledBackTx(pool, async (client) => {
    const wrong = { ...cfg, actor_id: '22222222-2222-4222-8222-000000000999' }
    await assert.rejects(
      intakeInTransaction(client, wrong, makeMaterial({ sha: hex64('m9005'), phone: { state: 'present', value: '13900009005' } }), DEMO_JOB),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'FORBIDDEN')
        assert.match((error as Error).message, /ACTOR_NOT_IN_TENANT/)
        return true
      },
    )
  })
})

test('岗位不存在 → NOT_FOUND(JOB_NOT_FOUND)', async () => {
  await inRolledBackTx(pool, async (client) => {
    await assert.rejects(
      intakeInTransaction(client, cfg, makeMaterial(), '00000000-0000-4000-8000-000000000000'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'NOT_FOUND')
        assert.match((error as Error).message, /JOB_NOT_FOUND/)
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
//  工具级（真实 execute）：真的起 Python converter 读 PDF
// ---------------------------------------------------------------------------

const converter = resolveConverterConfig({
  python_bin: 'D:\\Python3.12.9\\python.exe',
  converter_dir: 'D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter',
  allowed_roots: ['D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter\\corpus\\synthetic'],
})
const tool = createApplicationIntakeTool({
  converter: converter.resolved as NonNullable<typeof converter.resolved>,
  database: cfg,
})

test('工具级：零文本 PDF（无 PII）→ 真实 converter 读出"全不可读"→ BLOCKED_BY_REVIEW，不写库', async () => {
  const zeroText = 'D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter\\corpus\\synthetic\\zero_text.pdf'
  await assert.rejects(
    tool.execute({ path: zeroText, job_id: DEMO_JOB }, { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      assert.match((error as Error).message, /MATERIAL_ATTRIBUTION_UNKNOWN/)
      return true
    },
  )
})

test('工具级：allowed_roots 之外的路径 → FORBIDDEN（fail-closed）', async () => {
  await assert.rejects(
    tool.execute({ path: 'C:\\Windows\\win.ini.pdf', job_id: DEMO_JOB }, { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_FOUND')
      return true
    },
  )
  // 2026-11-14：allowed_roots 是**最外层**边界，现在先判路径再判媒体类型。
  // 修 S6 的格式盲区（DOCX 进不来）时去掉了"扩展名必须是 .pdf"的第一道判定，
  // 所以越界文件无论扩展名是什么，答案都是 FORBIDDEN —— 这才是 fail-closed 的正确顺序
  // （旧实现先按扩展名判 INVALID_ARGS，把"越界"说成了"参数不合法"）。
  await assert.rejects(
    tool.execute({ path: 'D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter\\src\\cli.py', job_id: DEMO_JOB }, { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'FORBIDDEN')
      assert.match((error as Error).message, /PATH_OUTSIDE_ALLOWED_ROOTS/)
      return true
    },
  )
})

test('工具级：模型传 actor_id / 非 UUID 的 job_id → INVALID_ARGS（不静默忽略）', async () => {
  await assert.rejects(
    tool.execute({ path: 'D:\\x.pdf', job_id: DEMO_JOB, actor_id: cfg.actor_id }, { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.match((error as Error).message, /TENANT_OR_ACTOR_NOT_ALLOWED/)
      return true
    },
  )
  await assert.rejects(
    tool.execute({ path: 'D:\\x.pdf', job_id: 'job_0001' }, { signal: new AbortController().signal }),
    (error: unknown) => {
      assert.match((error as Error).message, /ID_NOT_UUID/)
      return true
    },
  )
})

test('夹具自检：seedScenario 造的申请能被 S6 幂等查询识别（同一 sha 不重复建）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true }],
      fields: undefined,
    })
    assert.ok(scenario.applicationId)
    // 该夹具的材料 sha 与 makeMaterial 的不同 → 不应命中它，应当新建
    const material = makeMaterial({ sha: hex64('different'), phone: { state: 'present', value: '13900009999' } })
    const value = await intakeInTransaction(client, cfg, material, scenario.jobId)
    assert.equal(value.created, true)
    // 再调一次同 sha → 命中刚建的那条（而不是夹具那条）
    const replay = await intakeInTransaction(client, cfg, material, scenario.jobId)
    assert.equal(replay.created, false)
    assert.equal(replay.application_id, value.application_id)
    assert.notEqual(replay.application_id, scenario.applicationId)
  })
})
