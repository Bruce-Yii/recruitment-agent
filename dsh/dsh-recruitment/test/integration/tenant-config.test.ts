// 企业自建配置（tenant-config）× 真实 PostgreSQL（ra_s6s7）的集成测试。
//
// 每条验收都**读库回验**，不信函数返回值自述：
//   C1  角色正例：create → CREATED；读回 permission_scopes 已排序、record_version=1、
//       created_by_actor_id = 执行账号、is_active。
//   C2  幂等：同内容重放 → UNCHANGED，同 id，**零写**（record_version 仍 1、只有 1 行）。
//   C3  同 code 不同内容 → ALREADY_EXISTS，库里仍是原内容（不静默覆盖）。
//   C4  非法权限范围（绕过工具层枚举，直接调领域）→ INVALID_ARGS + **0 行落库**。
//   C5  版本并发：update 成功 → v2；再用旧 expected=1 → VERSION_CONFLICT，库里仍是 v2 且名字没被改。
//   C6  同参数 update → UNCHANGED 且 record_version 不动（零 UPDATE）。
//   C7  **租户隔离（角色）**：B 租户建的配置，A 租户 list 看不到、get 报 NOT_FOUND。
//   C8  团队正例：create 带成员 → CREATED；成员数为 2、部门名来自 department。
//   C9  幂等：团队同内容 + 同成员集合重放 → UNCHANGED（record_version 仍 1）。
//   C10 非法引用：成员 actor 不存在 → INVALID_REFERENCE(ACTORS_NOT_FOUND) + 0 团队；
//      kind='SYSTEM' → INVALID_REFERENCE(ACTOR_NOT_HUMAN) + 0 团队；
//      别的租户的部门 → INVALID_REFERENCE(DEPARTMENT_NOT_FOUND)。
//   C11 成员生命周期：add → CREATED；重复 add → UNCHANGED；remove → UPDATED（软关闭）；
//      重复 remove → UNCHANGED；移除后可重新加入（新行，旧行仍是 is_active=false）。
//   C12 **租户隔离（团队）**：A 看不到 B 的团队（get NOT_FOUND）、B 的 list 里没有 A 的。
//   C13 流水线正例：create（0 阶段）→ add_stage → record_version 2，阶段名来自 stage_catalog。
//   C14 非法引用：stage_code 不在 stage_catalog → INVALID_REFERENCE(STAGE_CODE_UNKNOWN)，
//      阶段数不变、版本不变；重复阶段码 → ALREADY_EXISTS。
//   C15 阶段引用面试模板：add_stage_template → v3 且 get 里能看到引用；
//      重复挂同一版本 → ALREADY_EXISTS；引用别的租户的模板版本 → INVALID_REFERENCE。
//   C16 版本并发（流水线）：用旧 expected_record_version 加阶段 → VERSION_CONFLICT，阶段数不变。
//   C17 **租户隔离（流水线）**：B 看不到 A 的模板（get NOT_FOUND / list 为空）。
//   C18 数据库层独立兜底（不经过领域代码，直接 SQL）：
//      成员表复合外键拒非 HUMAN actor；配置表禁删（DELETE_FORBIDDEN）。
//
// 事务纪律（沿用 test/integration/db.ts）：全部用例在 `inRolledBackTx` 里跑，结束一律
// ROLLBACK —— 不污染 ra_s6s7。第二租户（B）也在同一个事务里建，随回滚消失。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addPipelineStage,
  addStageTemplate,
  addTeamMember,
  createPipeline,
  createRole,
  createTeam,
  getPipeline,
  getRole,
  getTeam,
  listPipelines,
  listRoles,
  listTeams,
  removeTeamMember,
  updatePipeline,
  updateRole,
  updateTeam,
} from '../../src/domain/tenant-config.ts'
import { createConfigPipelineTool } from '../../src/tools/config-pipeline.ts'
import { createConfigRoleTool } from '../../src/tools/config-role.ts'
import { createConfigTeamTool } from '../../src/tools/config-team.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  DEMO_DEPARTMENT,
  errorBody,
  hex64,
  HR_ACTOR,
  inRolledBackTx,
  one,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

/** 每次都要唯一、且满足 `^[A-Z][A-Z0-9_]{1,40}$` 的 code。 */
function code(prefix: string): string {
  return `${prefix}_${uniqueSuffix().toUpperCase()}`.slice(0, 41)
}

/**
 * 造第二租户（B）+ 它的部门 + 一个 HUMAN actor。**只在本事务里**存在（随 ROLLBACK 消失）。
 * @param client - 测试事务。
 * @returns B 租户的 id 集合。
 */
async function seedTenantB(client: DatabaseClient): Promise<{
  tenantId: string
  departmentId: string
  actorId: string
}> {
  const suffix = uniqueSuffix()
  const tenantId = await one(
    client,
    'insert into recruitment.organization (name, timezone) values ($1, $2) returning id',
    [`集成测试租户 B-${suffix}`, 'Asia/Shanghai'],
  )
  const departmentId = await one(
    client,
    'insert into recruitment.department (tenant_id, name) values ($1, $2) returning id',
    [tenantId, `B 部门-${suffix}`],
  )
  const actorId = await one(
    client,
    `insert into recruitment.actor (tenant_id, kind, display_name, primary_email, department_id)
     values ($1, 'HUMAN', $2, $3, $4) returning id`,
    [tenantId, `B 招聘负责人-${suffix}`, `b-${suffix}@example.test`, departmentId],
  )
  return { tenantId, departmentId, actorId }
}

/**
 * 造一个 interview_template_version（流水线阶段要引用的"已存在模板"）。
 * @param client - 测试事务。
 * @param tenantId - 租户（缺省演示租户）。
 * @returns 新建版本 id。
 */
async function seedInterviewTemplateVersion(
  client: DatabaseClient,
  tenantId = TENANT,
  actorId = HR_ACTOR,
): Promise<string> {
  const suffix = uniqueSuffix()
  const templateCode = `IT_${suffix.toUpperCase()}`.slice(0, 30)
  return await one(
    client,
    `insert into recruitment.interview_template_version
       (tenant_id, template_code, round_no, version_no, objective, briefing,
        focus_attributes, question_templates, feedback_form, payload_hash, created_by_actor_id)
     values ($1, $2, 1, 1, '集成测试面试模板', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $3, $4)
     returning id`,
    [tenantId, templateCode, hex64(`itv${suffix}`), actorId],
  )
}

/**
 * 断言一次调用失败 —— 并且**把失败从当前事务里摘出去**。
 *
 * 为什么必须用 SAVEPOINT：本文件有一批"期望数据库拦下"的负向用例
 * （引用完整性 / 唯一键 / 禁删触发器）。PG 里一条语句失败会让**整个事务**进入
 * aborted 状态（25P02），后面任何 SELECT 都会失败，测试就变成"在测上一句的副作用"。
 * `savepoint` + `rollback to savepoint` 把失败限制在子事务里，事务继续可用。
 *
 * 领域层**预检**抛出的错误（NOT_FOUND / INVALID_REFERENCE / VERSION_CONFLICT）
 * 不写库也不 abort，但同样套这层（幂等：没有改动时 ROLLBACK TO SAVEPOINT 无副作用）。
 * @param client - 测试事务。
 * @param fn - 期望失败的操作。
 * @param check - 错误断言（与 assert.rejects 的第二个参数同形）。
 */
async function expectRejects(
  client: DatabaseClient,
  fn: () => Promise<unknown>,
  check: (error: unknown) => boolean,
): Promise<void> {
  await client.query('savepoint tc_expect_failure')
  try {
    await assert.rejects(fn, check)
  } finally {
    await client.query('rollback to savepoint tc_expect_failure').catch(() => undefined)
  }
}

// =====================================================================
//  C1–C7 · 角色
// =====================================================================

test('C1 角色 create 正例：落库可读回，权限范围已排序，record_version=1', async () => {
  await inRolledBackTx(pool, async (client) => {
    const roleCode = code('TC_ROLE')
    const created = await createRole(client, {
      tenantId: TENANT,
      code: roleCode,
      name: '测试招聘负责人',
      description: '企业自建的角色',
      // 故意乱序 + 重复：服务端应去重并排序
      permissionScopes: ['JOB_WRITE', 'JOB_READ', 'JOB_WRITE'],
      createdByActorId: HR_ACTOR,
    })
    assert.equal(created.status, 'CREATED')
    assert.deepEqual([...created.value.permission_scopes], ['JOB_READ', 'JOB_WRITE'])

    const { rows } = await client.query(
      `select code, name, description, permission_scopes, is_active, record_version, created_by_actor_id
         from recruitment.role where id = $1 and tenant_id = $2`,
      [created.value.role_id, TENANT],
    )
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.code, roleCode)
    assert.equal(row.name, '测试招聘负责人')
    assert.equal(row.description, '企业自建的角色')
    assert.deepEqual(row.permission_scopes, ['JOB_READ', 'JOB_WRITE'])
    assert.equal(row.is_active, true)
    assert.equal(row.record_version, 1)
    assert.equal(row.created_by_actor_id, HR_ACTOR)
  })
})

test('C2 角色 create 幂等：同内容重放 → UNCHANGED，零写（版本不动、只有一行）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const roleCode = code('TC_ROLE')
    const input = {
      tenantId: TENANT,
      code: roleCode,
      name: '幂等角色',
      permissionScopes: ['JOB_READ', 'APPLICATION_READ'],
      createdByActorId: HR_ACTOR,
    }
    const first = await createRole(client, input)
    assert.equal(first.status, 'CREATED')

    const second = await createRole(client, { ...input, permissionScopes: ['APPLICATION_READ', 'JOB_READ'] })
    assert.equal(second.status, 'UNCHANGED')
    assert.equal(second.value.role_id, first.value.role_id)
    assert.equal(second.value.record_version, 1, '幂等命中必须零写：record_version 不许涨')

    const { rows } = await client.query(
      'select count(*)::int as n, max(record_version) as v from recruitment.role where tenant_id = $1 and code = $2',
      [TENANT, roleCode],
    )
    assert.equal(rows[0].n, 1)
    assert.equal(rows[0].v, 1)
  })
})

test('C3 角色 create 同 code 不同内容 → ALREADY_EXISTS，原内容不被覆盖', async () => {
  await inRolledBackTx(pool, async (client) => {
    const roleCode = code('TC_ROLE')
    await createRole(client, {
      tenantId: TENANT, code: roleCode, name: '原名', permissionScopes: ['JOB_READ'], createdByActorId: HR_ACTOR,
    })
    await expectRejects(
      client,
      async () => await createRole(client, {
        tenantId: TENANT, code: roleCode, name: '新名字', permissionScopes: ['JOB_WRITE'], createdByActorId: HR_ACTOR,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'ALREADY_EXISTS')
        assert.equal(body.reason_code, 'ROLE_CODE_TAKEN')
        return true
      },
    )
    const { rows } = await client.query(
      'select name, permission_scopes from recruitment.role where tenant_id = $1 and code = $2',
      [TENANT, roleCode],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, '原名')
    assert.deepEqual(rows[0].permission_scopes, ['JOB_READ'])
  })
})

test('C4 角色 create 非法权限范围 → INVALID_ARGS 且 0 行落库', async () => {
  await inRolledBackTx(pool, async (client) => {
    const roleCode = code('TC_BAD')
    await expectRejects(
      client,
      async () => await createRole(client, {
        tenantId: TENANT,
        code: roleCode,
        name: '非法范围',
        permissionScopes: ['JOB_READ', 'ROOT_ACCESS'],
        createdByActorId: HR_ACTOR,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'PERMISSION_SCOPE_UNKNOWN')
        return true
      },
    )
    const { rows } = await client.query(
      'select count(*)::int as n from recruitment.role where tenant_id = $1 and code = $2',
      [TENANT, roleCode],
    )
    assert.equal(rows[0].n, 0, '校验失败必须零写')
  })
})

test('C5/C6 角色 update：版本 +1；旧版本 → VERSION_CONFLICT 且零写；同参数 → UNCHANGED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const roleCode = code('TC_ROLE')
    const created = await createRole(client, {
      tenantId: TENANT, code: roleCode, name: '第一版', permissionScopes: ['JOB_READ'], createdByActorId: HR_ACTOR,
    })

    // C6：同参数 update = 零写
    const noop = await updateRole(client, {
      tenantId: TENANT, roleId: created.value.role_id, expectedRecordVersion: 1, name: '第一版',
    })
    assert.equal(noop.status, 'UNCHANGED')
    assert.equal(noop.value.record_version, 1)

    // 真更新 → v2
    const updated = await updateRole(client, {
      tenantId: TENANT,
      roleId: created.value.role_id,
      expectedRecordVersion: 1,
      name: '第二版',
      permissionScopes: ['JOB_READ', 'DECISION_RECORD'],
    })
    assert.equal(updated.status, 'UPDATED')
    assert.equal(updated.value.record_version, 2)

    // C5：拿旧版本再改 → VERSION_CONFLICT，库里仍是第二版 / v2
    await expectRejects(
      client,
      async () => await updateRole(client, {
        tenantId: TENANT, roleId: created.value.role_id, expectedRecordVersion: 1, name: '第三版',
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'VERSION_CONFLICT')
        assert.equal(body.reason_code, 'ROLE_RECORD_VERSION_MISMATCH')
        return true
      },
    )
    const { rows } = await client.query(
      'select name, record_version from recruitment.role where id = $1 and tenant_id = $2',
      [created.value.role_id, TENANT],
    )
    assert.equal(rows[0].name, '第二版')
    assert.equal(rows[0].record_version, 2)
  })
})

test('C7 租户隔离（角色）：B 的配置 A 看不到，A 的配置 B 也看不到', async () => {
  await inRolledBackTx(pool, async (client) => {
    const tenantB = await seedTenantB(client)
    const roleCode = code('TC_ISO')
    const createdInB = await createRole(client, {
      tenantId: tenantB.tenantId,
      code: roleCode,
      name: 'B 租户的角色',
      permissionScopes: ['JOB_READ'],
      createdByActorId: tenantB.actorId,
    })

    // A 的 list 里没有 B 的角色
    const listInA = await listRoles(client, { tenantId: TENANT })
    assert.equal(listInA.some((r) => r.role_id === createdInB.value.role_id), false, 'A 不该看到 B 的角色')

    // A 直接 get B 的角色 → NOT_FOUND（不区分"不存在"与"不是你的"）
    await expectRejects(
      client,
      async () => await getRole(client, { tenantId: TENANT, roleId: createdInB.value.role_id }),
      (error: unknown) => {
        assert.equal(errorBody(error).code, 'NOT_FOUND')
        return true
      },
    )

    // B 的 list 里正好是它自己刚建的那条（B 是空库起步）
    const listInB = await listRoles(client, { tenantId: tenantB.tenantId })
    assert.deepEqual(listInB.map((r) => r.role_id), [createdInB.value.role_id])

    // 反向：B 看不到 A 的种子角色
    const listInBAll = await listRoles(client, { tenantId: tenantB.tenantId, includeInactive: true })
    assert.equal(listInBAll.some((r) => r.code === 'ORG_ADMIN'), false, 'B 不该看到 A 的种子角色')
  })
})

// =====================================================================
//  C8–C12 · 团队
// =====================================================================

test('C8 团队 create 正例：带成员落库，部门名来自 department 表', async () => {
  await inRolledBackTx(pool, async (client) => {
    const teamCode = code('TC_TEAM')
    const secondActor = await one(
      client,
      `insert into recruitment.actor (tenant_id, kind, display_name, primary_email, department_id)
       values ($1, 'HUMAN', $2, $3, $4) returning id`,
      [TENANT, '第二成员', `m2-${uniqueSuffix()}@example.test`, DEMO_DEPARTMENT],
    )
    const created = await createTeam(client, {
      tenantId: TENANT,
      code: teamCode,
      name: '研发招聘小组',
      departmentId: DEMO_DEPARTMENT,
      description: '负责研发岗',
      memberActorIds: [HR_ACTOR, secondActor],
      memberTeamRole: 'RECRUITER',
      createdByActorId: HR_ACTOR,
    })
    assert.equal(created.status, 'CREATED')
    assert.equal(created.value.department_name.length > 0, true)
    assert.equal(created.value.members.length, 2)
    assert.deepEqual(
      created.value.members.map((m) => m.actor_id).sort(),
      [HR_ACTOR, secondActor].sort(),
    )
    assert.equal(created.value.members.every((m) => m.team_role === 'RECRUITER'), true)

    const { rows } = await client.query(
      `select t.code, t.record_version, (select count(*)::int from recruitment.hiring_team_member m
          where m.team_id = t.id and m.is_active) as n
         from recruitment.hiring_team t where t.id = $1 and t.tenant_id = $2`,
      [created.value.team_id, TENANT],
    )
    assert.equal(rows[0].code, teamCode)
    assert.equal(rows[0].record_version, 1)
    assert.equal(rows[0].n, 2)
  })
})

test('C9 团队 create 幂等：同内容 + 同成员集合 → UNCHANGED，版本不动', async () => {
  await inRolledBackTx(pool, async (client) => {
    const teamCode = code('TC_TEAM')
    const input = {
      tenantId: TENANT,
      code: teamCode,
      name: '幂等小组',
      departmentId: DEMO_DEPARTMENT,
      memberActorIds: [HR_ACTOR],
      memberTeamRole: 'INTERVIEWER',
      createdByActorId: HR_ACTOR,
    }
    const first = await createTeam(client, input)
    assert.equal(first.status, 'CREATED')
    const second = await createTeam(client, { ...input })
    assert.equal(second.status, 'UNCHANGED')
    assert.equal(second.value.team_id, first.value.team_id)
    assert.equal(second.value.record_version, 1)

    const { rows } = await client.query(
      'select count(*)::int as n from recruitment.hiring_team where tenant_id = $1 and code = $2',
      [TENANT, teamCode],
    )
    assert.equal(rows[0].n, 1)
  })
})

test('C10 团队非法引用：actor 不存在 / 非 HUMAN / 别的租户的部门 → INVALID_REFERENCE 且零写', async () => {
  await inRolledBackTx(pool, async (client) => {
    const tenantB = await seedTenantB(client)
    const teamCode = code('TC_TEAM')

    // (a) 成员 actor 不存在
    await expectRejects(
      client,
      async () => await createTeam(client, {
        tenantId: TENANT,
        code: teamCode,
        name: '坏成员组',
        departmentId: DEMO_DEPARTMENT,
        memberActorIds: ['99999999-9999-4999-8999-999999999999'],
        createdByActorId: HR_ACTOR,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_REFERENCE')
        assert.equal(body.reason_code, 'ACTORS_NOT_FOUND')
        return true
      },
    )

    // (b) 成员是 SYSTEM 账号（不是 HUMAN）
    const systemActor = await one(
      client,
      `insert into recruitment.actor (tenant_id, kind, display_name, primary_email)
       values ($1, 'SYSTEM', $2, $3) returning id`,
      [TENANT, '系统账号', `sys-${uniqueSuffix()}@example.test`],
    )
    await expectRejects(
      client,
      async () => await createTeam(client, {
        tenantId: TENANT,
        code: teamCode,
        name: '坏成员组',
        departmentId: DEMO_DEPARTMENT,
        memberActorIds: [systemActor],
        createdByActorId: HR_ACTOR,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_REFERENCE')
        assert.equal(body.reason_code, 'ACTOR_NOT_HUMAN')
        return true
      },
    )

    // (c) 部门属于别的租户
    await expectRejects(
      client,
      async () => await createTeam(client, {
        tenantId: TENANT,
        code: teamCode,
        name: '坏部门组',
        departmentId: tenantB.departmentId,
        createdByActorId: HR_ACTOR,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_REFERENCE')
        assert.equal(body.reason_code, 'DEPARTMENT_NOT_FOUND')
        return true
      },
    )

    const { rows } = await client.query(
      'select count(*)::int as n from recruitment.hiring_team where tenant_id = $1 and code = $2',
      [TENANT, teamCode],
    )
    assert.equal(rows[0].n, 0, '三次非法引用都必须零写')
  })
})

test('C11 成员生命周期：add / 重复 add / remove（软关闭）/ 重复 remove / 重新加入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const teamCode = code('TC_TEAM')
    const team = await createTeam(client, {
      tenantId: TENANT, code: teamCode, name: '成员生命周期组', departmentId: DEMO_DEPARTMENT,
      createdByActorId: HR_ACTOR,
    })
    const candidate = await one(
      client,
      `insert into recruitment.actor (tenant_id, kind, display_name, primary_email, department_id)
       values ($1, 'HUMAN', $2, $3, $4) returning id`,
      [TENANT, '候选成员', `m3-${uniqueSuffix()}@example.test`, DEMO_DEPARTMENT],
    )

    const added = await addTeamMember(client, {
      tenantId: TENANT, teamId: team.value.team_id, actorId: candidate, teamRole: 'COORDINATOR',
      addedByActorId: HR_ACTOR,
    })
    assert.equal(added.status, 'CREATED')
    assert.equal(added.value.members.filter((m) => m.is_active).length, 1)

    const again = await addTeamMember(client, {
      tenantId: TENANT, teamId: team.value.team_id, actorId: candidate, teamRole: 'COORDINATOR',
      addedByActorId: HR_ACTOR,
    })
    assert.equal(again.status, 'UNCHANGED')

    const removed = await removeTeamMember(client, {
      tenantId: TENANT, teamId: team.value.team_id, actorId: candidate,
    })
    assert.equal(removed.status, 'UPDATED')
    assert.equal(removed.value.members.filter((m) => m.is_active).length, 0, '移除后不该有在用成员')

    const removedAgain = await removeTeamMember(client, {
      tenantId: TENANT, teamId: team.value.team_id, actorId: candidate,
    })
    assert.equal(removedAgain.status, 'UNCHANGED', '重复移除是幂等')

    // 重新加入：允许（部分唯一索引只覆盖 is_active），历史行保留
    const reAdded = await addTeamMember(client, {
      tenantId: TENANT, teamId: team.value.team_id, actorId: candidate, teamRole: 'INTERVIEWER',
      addedByActorId: HR_ACTOR,
    })
    assert.equal(reAdded.status, 'CREATED')
    const { rows } = await client.query(
      `select count(*)::int as all_rows,
              count(*) filter (where is_active)::int as active_rows
         from recruitment.hiring_team_member
        where tenant_id = $1 and team_id = $2 and actor_id = $3`,
      [TENANT, team.value.team_id, candidate],
    )
    assert.equal(rows[0].all_rows, 2, '移除是软关闭：历史行必须保留')
    assert.equal(rows[0].active_rows, 1, '同时只能有一条在用成员')
  })
})

test('C12 团队 update 版本并发 + 租户隔离', async () => {
  await inRolledBackTx(pool, async (client) => {
    const tenantB = await seedTenantB(client)
    const teamCode = code('TC_TEAM')
    const team = await createTeam(client, {
      tenantId: TENANT, code: teamCode, name: '改名前', departmentId: DEMO_DEPARTMENT, createdByActorId: HR_ACTOR,
    })

    const updated = await updateTeam(client, {
      tenantId: TENANT, teamId: team.value.team_id, expectedRecordVersion: 1, name: '改名后', isActive: false,
    })
    assert.equal(updated.status, 'UPDATED')
    assert.equal(updated.value.record_version, 2)
    assert.equal(updated.value.is_active, false)

    await expectRejects(
      client,
      async () => await updateTeam(client, {
        tenantId: TENANT, teamId: team.value.team_id, expectedRecordVersion: 1, name: '又改名',
      }),
      (error: unknown) => {
        assert.equal(errorBody(error).code, 'VERSION_CONFLICT')
        return true
      },
    )
    const { rows } = await client.query(
      'select name, record_version, is_active from recruitment.hiring_team where id = $1 and tenant_id = $2',
      [team.value.team_id, TENANT],
    )
    assert.equal(rows[0].name, '改名后')
    assert.equal(rows[0].record_version, 2)
    assert.equal(rows[0].is_active, false)

    // 租户隔离：B 看不到 A 的团队
    await expectRejects(
      client,
      async () => await getTeam(client, { tenantId: tenantB.tenantId, teamId: team.value.team_id }),
      (error: unknown) => {
        assert.equal(errorBody(error).code, 'NOT_FOUND')
        return true
      },
    )
    assert.deepEqual(await listTeams(client, { tenantId: tenantB.tenantId }), [])
  })
})

// =====================================================================
//  C13–C17 · 流水线模板
// =====================================================================

test('C13 流水线 create + add_stage：版本 2，阶段名来自 stage_catalog', async () => {
  await inRolledBackTx(pool, async (client) => {
    const pipelineCode = code('TC_PL')
    const created = await createPipeline(client, {
      tenantId: TENANT, code: pipelineCode, name: '研发标准流程', createdByActorId: HR_ACTOR,
    })
    assert.equal(created.status, 'CREATED')
    assert.equal(created.value.stages.length, 0)
    assert.equal(created.value.record_version, 1)

    const withStage = await addPipelineStage(client, {
      tenantId: TENANT,
      pipelineTemplateId: created.value.pipeline_template_id,
      stageCode: 'S6',
      expectedRecordVersion: 1,
    })
    assert.equal(withStage.record_version, 2, '加阶段是聚合写：模板版本必须 +1')
    assert.equal(withStage.stages.length, 1)
    assert.equal(withStage.stages[0]?.stage_code, 'S6')
    assert.equal((withStage.stages[0]?.stage_name ?? '').length > 0, true, '阶段名必须来自 stage_catalog')
    assert.equal(withStage.stages[0]?.sort_order, 1)

    const second = await addPipelineStage(client, {
      tenantId: TENANT,
      pipelineTemplateId: created.value.pipeline_template_id,
      stageCode: 'S7',
      expectedRecordVersion: 2,
    })
    assert.equal(second.record_version, 3)
    assert.deepEqual(second.stages.map((s) => s.stage_code), ['S6', 'S7'])
    assert.deepEqual(second.stages.map((s) => s.sort_order), [1, 2])
  })
})

test('C14 流水线非法引用：未知 stage_code / 重复阶段码 → 拒绝且零写', async () => {
  await inRolledBackTx(pool, async (client) => {
    const pipelineCode = code('TC_PL')
    const created = await createPipeline(client, {
      tenantId: TENANT, code: pipelineCode, name: '非法引用流程', createdByActorId: HR_ACTOR,
    })

    // (a) stage_code 不在 stage_catalog
    await expectRejects(
      client,
      async () => await addPipelineStage(client, {
        tenantId: TENANT,
        pipelineTemplateId: created.value.pipeline_template_id,
        stageCode: 'S99',
        expectedRecordVersion: 1,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_REFERENCE')
        assert.equal(body.reason_code, 'STAGE_CODE_UNKNOWN')
        const detail = body.detail as { available_stage_codes?: string[] }
        assert.equal(Array.isArray(detail.available_stage_codes), true, '错误里要给出可用的阶段码')
        assert.equal(detail.available_stage_codes?.includes('S6'), true)
        return true
      },
    )
    const afterBad = await getPipeline(client, {
      tenantId: TENANT, pipelineTemplateId: created.value.pipeline_template_id,
    })
    assert.equal(afterBad.stages.length, 0, '非法引用必须零写')
    assert.equal(afterBad.record_version, 1, '非法引用不许动版本')

    // (b) 同一阶段码加两次
    await addPipelineStage(client, {
      tenantId: TENANT, pipelineTemplateId: created.value.pipeline_template_id,
      stageCode: 'S6', expectedRecordVersion: 1,
    })
    await expectRejects(
      client,
      async () => await addPipelineStage(client, {
        tenantId: TENANT, pipelineTemplateId: created.value.pipeline_template_id,
        stageCode: 'S6', expectedRecordVersion: 2,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'ALREADY_EXISTS')
        assert.equal(body.reason_code, 'PIPELINE_STAGE_EXISTS')
        return true
      },
    )
  })
})

test('C15 阶段引用面试模板：钉版本、重复拒绝、跨租户拒绝', async () => {
  await inRolledBackTx(pool, async (client) => {
    const tenantB = await seedTenantB(client)
    const pipelineCode = code('TC_PL')
    const created = await createPipeline(client, {
      tenantId: TENANT, code: pipelineCode, name: '带面试模板的流程', createdByActorId: HR_ACTOR,
    })
    const itvId = await seedInterviewTemplateVersion(client)
    const stage = await addPipelineStage(client, {
      tenantId: TENANT,
      pipelineTemplateId: created.value.pipeline_template_id,
      stageCode: 'S8',
      expectedRecordVersion: 1,
      interviewTemplateVersionIds: [itvId],
    })
    assert.equal(stage.record_version, 2)
    const stageId = stage.stages[0]?.stage_id as string
    assert.equal(stage.stages[0]?.interview_templates.length, 1)
    assert.equal(stage.stages[0]?.interview_templates[0]?.interview_template_version_id, itvId)
    assert.equal(stage.stages[0]?.interview_templates[0]?.version_no, 1)

    // 重复挂同一版本 → ALREADY_EXISTS
    await expectRejects(
      client,
      async () => await addStageTemplate(client, {
        tenantId: TENANT, stageId, interviewTemplateVersionId: itvId, expectedRecordVersion: 2,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'ALREADY_EXISTS')
        assert.equal(body.reason_code, 'STAGE_TEMPLATE_DUPLICATED')
        return true
      },
    )

    // 引用别的租户的模板版本 → INVALID_REFERENCE
    const foreignItv = await one(
      client,
      `insert into recruitment.interview_template_version
         (tenant_id, template_code, round_no, version_no, payload_hash)
       values ($1, $2, 1, 1, $3) returning id`,
      [tenantB.tenantId, `B_IT_${uniqueSuffix().toUpperCase()}`.slice(0, 30), hex64(`itvb${uniqueSuffix()}`)],
    )
    await expectRejects(
      client,
      async () => await addStageTemplate(client, {
        tenantId: TENANT, stageId, interviewTemplateVersionId: foreignItv, expectedRecordVersion: 2,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_REFERENCE')
        assert.equal(body.reason_code, 'TEMPLATE_VERSION_NOT_FOUND')
        return true
      },
    )
  })
})

test('C16 流水线版本并发：旧版本加阶段 → VERSION_CONFLICT，阶段数不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const pipelineCode = code('TC_PL')
    const created = await createPipeline(client, {
      tenantId: TENANT, code: pipelineCode, name: '并发流程', createdByActorId: HR_ACTOR,
    })
    const v2 = await addPipelineStage(client, {
      tenantId: TENANT, pipelineTemplateId: created.value.pipeline_template_id,
      stageCode: 'S6', expectedRecordVersion: 1,
    })
    assert.equal(v2.record_version, 2)

    await expectRejects(
      client,
      async () => await addPipelineStage(client, {
        tenantId: TENANT, pipelineTemplateId: created.value.pipeline_template_id,
        stageCode: 'S7', expectedRecordVersion: 1,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'VERSION_CONFLICT')
        assert.equal(body.reason_code, 'PIPELINE_RECORD_VERSION_MISMATCH')
        return true
      },
    )
    const after = await getPipeline(client, {
      tenantId: TENANT, pipelineTemplateId: created.value.pipeline_template_id,
    })
    assert.equal(after.stages.length, 1, '冲突必须零写')
    assert.equal(after.record_version, 2)
  })
})

test('C17 租户隔离（流水线）：B 看不到 A 的模板与阶段', async () => {
  await inRolledBackTx(pool, async (client) => {
    const tenantB = await seedTenantB(client)
    const pipelineCode = code('TC_PL')
    const created = await createPipeline(client, {
      tenantId: TENANT, code: pipelineCode, name: 'A 的流程', createdByActorId: HR_ACTOR,
    })
    await addPipelineStage(client, {
      tenantId: TENANT, pipelineTemplateId: created.value.pipeline_template_id,
      stageCode: 'S6', expectedRecordVersion: 1,
    })

    await expectRejects(
      client,
      async () => await getPipeline(client, {
        tenantId: tenantB.tenantId, pipelineTemplateId: created.value.pipeline_template_id,
      }),
      (error: unknown) => {
        assert.equal(errorBody(error).code, 'NOT_FOUND')
        return true
      },
    )
    assert.deepEqual(await listPipelines(client, { tenantId: tenantB.tenantId }), [])

    // B 也不能拿自己的模板去引用 A 的阶段（阶段 id 跨租户 → NOT_FOUND）
    const stageId = (await getPipeline(client, {
      tenantId: TENANT, pipelineTemplateId: created.value.pipeline_template_id,
    })).stages[0]?.stage_id as string
    const pipelineInB = await createPipeline(client, {
      tenantId: tenantB.tenantId, code: code('TC_PLB'), name: 'B 的流程', createdByActorId: tenantB.actorId,
    })
    await expectRejects(
      client,
      async () => await addStageTemplate(client, {
        tenantId: tenantB.tenantId,
        stageId,
        interviewTemplateVersionId: await seedInterviewTemplateVersion(client, tenantB.tenantId, tenantB.actorId),
        expectedRecordVersion: pipelineInB.value.record_version,
      }),
      (error: unknown) => {
        assert.equal(errorBody(error).code, 'NOT_FOUND')
        return true
      },
    )
  })
})

// =====================================================================
//  C18 · 数据库层独立兜底（不经过领域代码，直接 SQL）
// =====================================================================

test('C18 数据库层兜底：成员复合外键拒非 HUMAN；配置表禁删', async () => {
  await inRolledBackTx(pool, async (client) => {
    const teamCode = code('TC_DB')
    const team = await createTeam(client, {
      tenantId: TENANT, code: teamCode, name: '数据库兜底组', departmentId: DEMO_DEPARTMENT,
      createdByActorId: HR_ACTOR,
    })
    const systemActor = await one(
      client,
      `insert into recruitment.actor (tenant_id, kind, display_name, primary_email)
       values ($1, 'SYSTEM', $2, $3) returning id`,
      [TENANT, '系统账号2', `sys2-${uniqueSuffix()}@example.test`],
    )

    // 绕过领域预检直接插入非 HUMAN 成员：复合外键 (actor_id, tenant_id, actor_kind)
    // 在 actor 里找不到 (id, tenant_id, 'HUMAN') 组合 → 23503。
    await expectRejects(
      client,
      async () => await client.query(
        `insert into recruitment.hiring_team_member (tenant_id, team_id, actor_id)
         values ($1, $2, $3)`,
        [TENANT, team.value.team_id, systemActor],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23503')
        return true
      },
    )

    // 配置表禁删（fn_block_delete → 23514 DELETE_FORBIDDEN）
    await expectRejects(
      client,
      async () => await client.query('delete from recruitment.hiring_team where id = $1', [team.value.team_id]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23514')
        assert.match(String((error as Error).message), /DELETE_FORBIDDEN/)
        return true
      },
    )
  })
})

// =====================================================================
//  工具层接线：三个工具都能在真实库上跑通一次（注册前的"可达性"证据）
// =====================================================================

test('C19 工具层：三个 create 工具真实执行成功（tenant 来自插件配置）', async () => {
  // 工具自己管连接池：这里用一个**能提交**的独立调用，然后在 finally 里清理自己造的数据。
  const toolCfg: ResolvedDatabaseConfig = { ...cfg, tenant_id: TENANT, actor_id: HR_ACTOR }
  const roleTool = createConfigRoleTool(toolCfg)
  const teamTool = createConfigTeamTool(toolCfg)
  const pipelineTool = createConfigPipelineTool(toolCfg)

  const roleCode = `TCT_${uniqueSuffix().toUpperCase()}`.slice(0, 41)
  const teamCode = `TCTT_${uniqueSuffix().toUpperCase()}`.slice(0, 41)
  const pipelineCode = `TCTP_${uniqueSuffix().toUpperCase()}`.slice(0, 41)

  try {
    const roleValue = await roleTool.execute({
      operation: 'create',
      code: roleCode,
      name: '工具层角色',
      permission_scopes: ['JOB_READ', 'CONFIG_ADMIN'],
    }) as { status: string; role?: { role_id: string; permission_scopes: string[] }; labels: { provenance: string } }
    assert.equal(roleValue.status, 'CREATED')
    assert.deepEqual(roleValue.role?.permission_scopes, ['CONFIG_ADMIN', 'JOB_READ'])
    assert.ok(['LIVE', 'FIXTURE'].includes(roleValue.labels.provenance), 'R4：provenance 只能是 LIVE/FIXTURE')

    const teamValue = await teamTool.execute({
      operation: 'create',
      code: teamCode,
      name: '工具层团队',
      department_id: DEMO_DEPARTMENT,
      member_actor_ids: [HR_ACTOR],
    }) as { status: string; team?: { team_id: string; members: { actor_id: string }[] } }
    assert.equal(teamValue.status, 'CREATED')
    assert.deepEqual(teamValue.team?.members.map((m) => m.actor_id), [HR_ACTOR])

    const pipelineValue = await pipelineTool.execute({
      operation: 'create',
      code: pipelineCode,
      name: '工具层流程',
    }) as { status: string; pipeline?: { pipeline_template_id: string; record_version: number } }
    assert.equal(pipelineValue.status, 'CREATED')

    // 工具层错误格式：`<CODE>: <compact-json>`（这个用例不写库 = 事务不会 abort，直接断言）
    await assert.rejects(
      async () => await roleTool.execute({ operation: 'get', role_id: 'not-a-uuid' }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /^INVALID_ARGS: \{/)
        return true
      },
    )
  } finally {
    // 清理自己造的夹具（工具层不提供删除）。用 session_replication_role 临时绕过禁删触发器 ——
    // 只在本事务内生效，且这里删的确实是**测试自己刚造的**数据。
    const cleanup = await pool.connect()
    try {
      await cleanup.query('begin')
      await cleanup.query("set local session_replication_role = replica")
      await cleanup.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
      await cleanup.query(
        `with p as (select id from recruitment.pipeline_template where tenant_id = $1 and code = $2)
         delete from recruitment.pipeline_template_stage_template
          where stage_id in (select s.id from recruitment.pipeline_template_stage s
                              join p on p.id = s.pipeline_template_id)`,
        [TENANT, pipelineCode],
      )
      await cleanup.query(
        `delete from recruitment.pipeline_template_stage
          where pipeline_template_id in (select id from recruitment.pipeline_template where tenant_id = $1 and code = $2)`,
        [TENANT, pipelineCode],
      )
      await cleanup.query('delete from recruitment.pipeline_template where tenant_id = $1 and code = $2', [TENANT, pipelineCode])
      await cleanup.query(
        `delete from recruitment.hiring_team_member
          where team_id in (select id from recruitment.hiring_team where tenant_id = $1 and code = $2)`,
        [TENANT, teamCode],
      )
      await cleanup.query('delete from recruitment.hiring_team where tenant_id = $1 and code = $2', [TENANT, teamCode])
      await cleanup.query(
        `delete from recruitment.actor_role where role_id in
           (select id from recruitment.role where tenant_id = $1 and code = $2)`,
        [TENANT, roleCode],
      )
      await cleanup.query('delete from recruitment.role where tenant_id = $1 and code = $2', [TENANT, roleCode])
      await cleanup.query('commit')
    } catch (error) {
      await cleanup.query('rollback').catch(() => undefined)
      throw error
    } finally {
      cleanup.release()
    }
  }
})
