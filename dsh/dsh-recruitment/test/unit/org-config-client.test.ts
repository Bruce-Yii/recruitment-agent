// G-18：企业组织配置（角色/流程模板）客户端入参校验单测。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildCreatePipelineBody, buildCreateRoleBody, buildCreateTeamBody, buildDeactivatePipelineBody, buildDeactivateRoleBody, ORG_CONFIG_ACTION_PATHS } from '../../src/client/org-config.ts'

describe('G-18 org-config 客户端契约校验', () => {
  test('角色与流程模板写路径对齐服务端 actions.ts 契约', () => {
    assert.equal(ORG_CONFIG_ACTION_PATHS.role, '/recruitment/api/action/config/role')
    assert.equal(ORG_CONFIG_ACTION_PATHS.team, '/recruitment/api/action/config/team')
    assert.equal(ORG_CONFIG_ACTION_PATHS.pipeline, '/recruitment/api/action/config/pipeline')
  })

  test('buildCreateRoleBody：正常组装与空字段拦截', () => {
    const ok = buildCreateRoleBody({
      code: ' hiring_partner ',
      name: ' 业务招聘伙伴 ',
      permissionScopes: ['JOB_READ', 'APPLICATION_READ'],
    })
    assert.equal(ok.operation, 'create')
    assert.equal(ok.code, 'hiring_partner')
    assert.equal(ok.name, '业务招聘伙伴')
    assert.deepEqual(ok.permission_scopes, ['JOB_READ', 'APPLICATION_READ'])

    assert.throws(() => buildCreateRoleBody({ code: '', name: 'x', permissionScopes: ['JOB_READ'] }))
    assert.throws(() => buildCreateRoleBody({ code: 'x', name: 'y', permissionScopes: [] }))
  })

  test('buildCreatePipelineBody：正常组装与空字段拦截', () => {
    const ok = buildCreatePipelineBody({
      code: 'tech_std',
      name: '研发标准流程',
      description: '三轮面试',
    })
    assert.equal(ok.operation, 'create')
    assert.equal(ok.code, 'tech_std')
    assert.equal(ok.name, '研发标准流程')
    assert.equal(ok.description, '三轮面试')

    assert.throws(() => buildCreatePipelineBody({ code: '', name: 'x' }))
    assert.throws(() => buildCreatePipelineBody({ code: 'x', name: '' }))
  })

  test('buildCreateTeamBody 与软停用 payload 校验', () => {
    const team = buildCreateTeamBody({
      code: 'eng_be',
      name: '后端招聘组',
      departmentId: '00000000-0000-4000-8000-000000000010',
    })
    assert.equal(team.operation, 'create')
    assert.equal(team.department_id, '00000000-0000-4000-8000-000000000010')
    assert.throws(() => buildCreateTeamBody({ code: 'eng_be', name: 'x', departmentId: 'bad-id' }))

    const dr = buildDeactivateRoleBody('role-1', 2)
    assert.equal(dr.operation, 'update')
    assert.equal(dr.is_active, false)
    assert.equal(dr.expected_record_version, 2)

    const dp = buildDeactivatePipelineBody('pipe-1', 3)
    assert.equal(dp.operation, 'update')
    assert.equal(dp.is_active, false)
    assert.equal(dp.expected_record_version, 3)
  })
})
