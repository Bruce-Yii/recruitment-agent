// Issue #24 / G-01 补完：自动初筛"只读不落痕"缺口的可读性单测（不连库、不起服务）。
//
// 覆盖四块：
//   1. 服务端读模型 `mapAutoScreeningResultRef`：从 business_task.result_ref（JSON 文本）读回摘要；
//      老格式（裸 sha256）/ 坏 JSON / 缺 auto_screening 分片 → null（诚实降级，不猜）；
//   2. `result_ref` JSON 必须保留 material_sha256 原文 hash；
//   3. 客户端 `view-model::normalizeAutoScreening` + `buildApplicationRow`：映射到 autoScreening；
//   4. `normalize-canvas::normalizeApplicationDetail`：候选人页 VM 拿到 autoScreening 并进 summaryText，
//      且 CandidatePage.tsx 静态断言有渲染位（推荐/非决定口径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mapAutoScreeningResultRef } from '../../src/http/recruiting.ts'
import {
  buildApplicationRow,
  normalizeAutoScreening,
  type AutoScreeningView,
} from '../../src/client/recruiting/view-model.ts'
import { normalizeApplicationDetail } from '../../src/client/normalize-canvas.ts'

const MATERIAL_SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const RESULT_REF = JSON.stringify({
  material_sha256: MATERIAL_SHA,
  auto_screening: {
    verdict: 'NEEDS_REVIEW',
    verdict_summary: '存在未覆盖维度，建议人工复核',
    required_human_action: 'ANSWER_JUDGMENT',
    rubric_version_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    evaluation_digest: 'abc123',
    reasons: [
      {
        code: 'MUST_HAVE_NEEDS_JUDGMENT',
        criterion_key: 'backend_exp',
        tri_state: 'present',
        outcome: 'NEEDS_JUDGMENT',
        message: '需要人工判断业务经验',
      },
    ],
    advisory: true,
    advisory_note: '这是只读评估给出的建议，不是录用决定；请由招聘团队成员确认。',
  },
})

// ---------------------------------------------------------------------------
//  1. 服务端读模型
// ---------------------------------------------------------------------------

test('mapAutoScreeningResultRef：result_ref JSON 读回摘要，保留 material_sha256', () => {
  const view = mapAutoScreeningResultRef(RESULT_REF, '')
  assert.ok(view !== null)
  assert.equal(view.material_sha256, MATERIAL_SHA)
  assert.equal(view.verdict, 'NEEDS_REVIEW')
  assert.equal(view.verdict_summary, '存在未覆盖维度，建议人工复核')
  assert.equal(view.required_human_action, 'ANSWER_JUDGMENT')
  assert.equal(view.advisory, true)
  assert.match(view.advisory_note, /建议.*不是.*决定/)
  assert.equal(view.reasons.length, 1)
  assert.deepEqual(view.reasons[0], {
    code: 'MUST_HAVE_NEEDS_JUDGMENT',
    criterion_key: 'backend_exp',
    tri_state: 'present',
    outcome: 'NEEDS_JUDGMENT',
    message: '需要人工判断业务经验',
  })
  // 非决定字段：没有 decision_id / result / decided_at。
  assert.equal(Object.keys(view).some((k) => /decision|decided|^result$/i.test(k)), false)
})

test('mapAutoScreeningResultRef：老格式裸 sha256 / 坏 JSON / 缺分片 → null', () => {
  assert.equal(mapAutoScreeningResultRef(MATERIAL_SHA, ''), null, '裸 sha256 是老格式，无建议')
  assert.equal(mapAutoScreeningResultRef('{not json', ''), null, '坏 JSON 不猜')
  assert.equal(mapAutoScreeningResultRef(JSON.stringify({ material_sha256: MATERIAL_SHA }), ''), null)
  assert.equal(mapAutoScreeningResultRef(null, ''), null)
  assert.equal(mapAutoScreeningResultRef(undefined, MATERIAL_SHA), null)
  // material_sha256 缺省时用 fallback 兜底（有 auto_screening 分片才成立）。
  const noHash = JSON.stringify({ auto_screening: { verdict: 'PASS', verdict_summary: 'ok' } })
  const fallback = mapAutoScreeningResultRef(noHash, MATERIAL_SHA)
  assert.ok(fallback !== null)
  assert.equal(fallback.material_sha256, MATERIAL_SHA)
})

test('读模型 SQL 接线：按 business_refs 的 APPLICATION 引用定位 result_ref', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', '..', 'src', 'http', 'recruiting.ts'), 'utf8')
  assert.match(source, /AUTO_SCREENING_SQL/)
  assert.match(source, /jsonb_array_elements\(b\.business_refs\)/)
  assert.match(source, /ref->>'kind'\s*=\s*'APPLICATION'/)
  assert.match(source, /auto_screening:\s*autoScreeningByApplication\.get/)
})

// ---------------------------------------------------------------------------
//  2. 客户端 view-model 映射
// ---------------------------------------------------------------------------

test('normalizeAutoScreening：映射 verdict / 三态 / "建议不是决定"', () => {
  const view: AutoScreeningView | null = normalizeAutoScreening(JSON.parse(RESULT_REF).auto_screening)
  assert.ok(view !== null)
  assert.equal(view.verdict, 'NEEDS_REVIEW')
  assert.equal(view.verdictLabel, '建议人工复核')
  assert.equal(view.verdictTone, 'amber')
  assert.match(view.advisoryNote, /建议.*不是.*决定/)
  assert.equal(view.reasons[0]?.triState, 'present')
  assert.match(view.summaryText, /自动初筛\s*建议人工复核/)
  assert.match(view.summaryText, /不是.*决定/)
})

test('normalizeAutoScreening：坏类型 → null，不撑爆视图', () => {
  assert.equal(normalizeAutoScreening(null), null)
  assert.equal(normalizeAutoScreening('x'), null)
  assert.equal(normalizeAutoScreening({}), null)
})

test('buildApplicationRow：auto_screening 字段映射到 autoScreening，无字段则为 null', () => {
  const withAuto = buildApplicationRow({
    application_id: '11111111-1111-4111-8111-111111111111',
    candidate: { candidate_id: 'x', display_name: '候选人' },
    job: { job_id: 'y', code: 'J1', title: '岗位' },
    auto_screening: JSON.parse(RESULT_REF).auto_screening,
  })
  assert.ok(withAuto.autoScreening !== null)
  assert.equal(withAuto.autoScreening.verdict, 'NEEDS_REVIEW')
  assert.match(withAuto.autoScreening.advisoryNote, /不是.*决定/)

  const withoutAuto = buildApplicationRow({
    application_id: '11111111-1111-4111-8111-111111111111',
    candidate: { candidate_id: 'x', display_name: '候选人' },
    job: { job_id: 'y', code: 'J1', title: '岗位' },
  })
  assert.equal(withoutAuto.autoScreening, null)
})

// ---------------------------------------------------------------------------
//  3. 候选人页 Canvas VM + 静态渲染断言
// ---------------------------------------------------------------------------

test('normalizeApplicationDetail：候选人页拿到 autoScreening 并进 summaryText', () => {
  const vm = normalizeApplicationDetail({
    application: {
      application_id: '11111111-1111-4111-8111-111111111111',
      candidate: { display_name: '候选人' },
      job: { job_id: 'y', code: 'J1', title: '岗位' },
      auto_screening: JSON.parse(RESULT_REF).auto_screening,
    },
  })
  assert.ok(vm.autoScreening !== null)
  assert.equal(vm.autoScreening.verdictLabel, '建议人工复核')
  assert.match(vm.autoScreening.advisoryNote, /不是.*决定/)
  assert.match(vm.summaryText, /自动初筛建议人工复核/)
  assert.match(vm.summaryText, /建议/)

  const vmNoAuto = normalizeApplicationDetail({
    application: {
      application_id: '11111111-1111-4111-8111-111111111111',
      candidate: { display_name: '候选人' },
      job: { job_id: 'y', code: 'J1', title: '岗位' },
    },
  })
  assert.equal(vmNoAuto.autoScreening, null)
})

test('候选人页静态断言：CandidatePage 渲染 auto-screening 且标注建议口径', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', '..', 'src', 'client', 'canvas', 'CandidatePage.tsx'), 'utf8')
  assert.match(source, /vm\.autoScreening/, '候选人页必须读取 autoScreening VM')
  assert.match(source, /data-testid="canvas-auto-screening"/, '有稳定测试锚点')
  assert.match(source, /自动初筛建议/, '给出明确的自动初筛区块标题')
  assert.match(source, /vm\.autoScreening\.advisoryNote/, '渲染"建议不是决定"提示')
  // 不新增弹窗：区块内只有静态 doc-block，没有新的 Modal 弹窗调用。
  assert.equal(/autoScreening[\s\S]{0,200}Modal/.test(source), false)
})
