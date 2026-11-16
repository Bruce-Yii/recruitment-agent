// S10 评价线 · manual 夹具的**维度真值**读取器（不是产品代码，是 .mjs 纯 JS）。
//
// 为什么需要它（2026-11-16 现场事实）：演示夹具已把申请 `…0701` 的 pin 从 v1 改成 v2
// （`work_exists` / `edu_exists` / `team_lead`，由 `scripts/bootstrap-demo.mjs` 的 O3 纠偏写入）。
// manual 里的 goal / 负例若继续硬编码 `backend_depth` / `async_pipeline` / `frontend_basics`，
// 重跑就会被 `recruitment_scorecard_submit` 以 `DIMENSION_NOT_IN_RUBRIC` 拒绝——
// 那是**正确**的 fail-closed（items 键集必须恰好覆盖申请钉住 rubric 的 dimensions），
// 错的是 manual 夹具把版本事实写死了。
//
// 本文件只做一件事：**从库里读申请钉住的 rubric 的真实 dimensions**，并据此生成
// scorecard items / 维度键说明。**不硬编码任何版本、任何维度键**；读不到就 fail-closed（不猜、不回退默认值）。
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   $env:RECRUITMENT_DB_NAME='ra_s6s7'   # 可选；默认 ra_s6s7（演示库）
//   node manual/evaluation-line/negatives.mjs
import pg from 'pg'

import { resolveDatabaseConfig } from '../../src/db/pool.ts'

/** 演示租户（0002_seed）。 */
export const DEMO_TENANT = '11111111-1111-4111-8111-000000000001'
/** 演示申请（S6→S7→S10 的那一条；rubric pin 的唯一事实来源）。 */
export const DEMO_APPLICATION = '11111111-1111-4111-8111-000000000701'
/** 演示第一轮面试（X/Y 各交一份面评）。 */
export const DEMO_INTERVIEW_R1 = '11111111-1111-4111-8111-000000000801'
/** 演示第二轮面试（负例：缺面评）。 */
export const DEMO_INTERVIEW_R2 = '11111111-1111-4111-8111-000000000802'
/** 演示转写产物（evaluation-line seed 造的人工导入转写）。 */
export const DEMO_TRANSCRIPT_ARTIFACT = '11111111-1111-4111-8111-000000000a01'

/**
 * manual 脚本的数据库配置：与产品同一份解析函数（密码只从环境变量读）。
 * 库名优先 `RECRUITMENT_DB_NAME`，否则退回 `ra_s6s7` 演示库（沿用手工联调口径）。
 * @returns 已解析配置。
 */
export function manualDatabaseConfig() {
  const { resolved, issues } = resolveDatabaseConfig({
    host: process.env.RECRUITMENT_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.RECRUITMENT_DB_PORT ?? 5432),
    user: process.env.RECRUITMENT_DB_USER ?? 'postgres',
    database: process.env.RECRUITMENT_DB_NAME ?? 'ra_s6s7',
    tenant_id: DEMO_TENANT,
    actor_id: '11111111-1111-4111-8111-000000000103',
  }, process.env)
  if (resolved === null) {
    throw new Error(`manual 脚本需要可用的数据库配置：${issues.join('; ')}（先设 $env:RECRUITMENT_DB_PASSWORD）`)
  }
  return resolved
}

/**
 * 运行期收窄：dimensions 必须是至少 1 条、每条有非空 key。
 * @param {unknown} raw - `rubric_version.dimensions`。
 * @returns {Array<{key: string, label: string, kind: string, weight: number}>}
 */
function normalizeDimensions(raw) {
  if (!Array.isArray(raw)) throw new Error('rubric_version.dimensions 不是数组：无法生成面评参数')
  /** @type {Array<{key: string, label: string, kind: string, weight: number}>} */
  const out = []
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`rubric_version.dimensions[${index}] 不是对象`)
    }
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    if (key === '') throw new Error(`rubric_version.dimensions[${index}].key 为空：无法生成面评参数`)
    out.push({
      key,
      label: typeof item.label === 'string' && item.label !== '' ? item.label : key,
      kind: typeof item.kind === 'string' ? item.kind : '',
      weight: typeof item.weight === 'number' && Number.isFinite(item.weight) ? item.weight : 0,
    })
  }
  if (out.length === 0) throw new Error('rubric 没有任何维度：无法生成面评参数（先跑 scripts/bootstrap-demo.mjs）')
  return out
}

/**
 * 读申请钉住的 rubric 的真实 dimensions（只读）。
 *
 * 为什么 pin 为 null 要 fail-closed：`scorecard_submit` 的 SC-10 明确"没有钉住版本必须显式给
 * rubric_version_id，不做 fallback"。manual 夹具若在这里猜一个版本，就会掩盖产品真实状态。
 * @param {string} [applicationId] - 申请 id（默认演示申请）。
 * @returns {Promise<{application_id: string, rubric_version_id: string, version_no: number, payload_hash: string, dimensions: Array<{key: string, label: string, kind: string, weight: number}>}>}
 */
export async function readPinnedRubric(applicationId = DEMO_APPLICATION) {
  const cfg = manualDatabaseConfig()
  const pool = new pg.Pool({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database,
    password: cfg.password, max: 1, application_name: 'evaluation-line-pinned-rubric',
  })
  try {
    const { rows } = await pool.query(
      `select a.id::text as application_id, a.rubric_version_id::text as rubric_version_id,
              rv.version_no, rv.payload_hash, rv.dimensions
         from recruitment.application a
         join recruitment.rubric_version rv
           on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
        where a.id = $1 and a.tenant_id = $2`,
      [applicationId, DEMO_TENANT],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error(
        `申请 ${applicationId} 没有钉住 rubric（或申请不存在）：manual 面评夹具无法确定维度。`
        + ' 先跑 scripts/bootstrap-demo.mjs（O3 会把不可执行的 pin 纠偏到同岗位的已批准可执行版本）。',
      )
    }
    return {
      application_id: String(row.application_id),
      rubric_version_id: String(row.rubric_version_id),
      version_no: Number(row.version_no),
      payload_hash: String(row.payload_hash),
      dimensions: normalizeDimensions(row.dimensions),
    }
  } finally {
    await pool.end()
  }
}

/** 面评 note 里可用的确定性分值序列（演示用；不参与任何校验）。 */
const SCORES = [4, 3, 2, 3, 4]

/**
 * 按真实 dimensions 生成 `items` 对象（键 = dimensions[].key ∪ {transcript_basis}）。
 *
 * 每条 MET 都带 note（满足 scorecard 的"ADVANCE 时每条 MET 至少带 note 或 evidence"），
 * 不伪造 transcript segment 证据（负例里另造）。
 * @param {Array<{key: string, label: string, kind: string, weight: number}>} dimensions - 库里读到的真实维度。
 * @param {{notePrefix?: string}} [options] - `notePrefix` 可改前缀。
 * @returns {Record<string, unknown>} 可直接传给 `recruitment_scorecard_submit` 的 items。
 */
export function scorecardItemsFromDimensions(dimensions, options = {}) {
  const prefix = options.notePrefix ?? '演示面评（按库内 rubric 维度记录）'
  /** @type {Record<string, unknown>} */
  const items = { transcript_basis: 'TRANSCRIPT' }
  dimensions.forEach((dimension, index) => {
    items[dimension.key] = {
      assessment: 'MET',
      score: SCORES[index % SCORES.length],
      note: `${prefix}：${dimension.label}（${dimension.key}）`,
    }
  })
  return items
}

/**
 * 负例 items：在第一条真实维度上挂一个**已作废**的 `TRANSCRIPT_SEGMENT` 证据 kind。
 * @param {Array<{key: string, label: string, kind: string, weight: number}>} dimensions - 库里读到的真实维度。
 * @returns {Record<string, unknown>} items（其余维度假定为合法，只有第一条证据 kind 错）。
 */
export function scorecardItemsWithInvalidEvidenceKind(dimensions) {
  const items = scorecardItemsFromDimensions(dimensions, { notePrefix: '负例：证据 kind 作废' })
  const first = dimensions[0]
  if (first !== undefined) {
    items[first.key] = {
      assessment: 'MET',
      score: 4,
      note: '负例：evidence[].kind 用已作废的 TRANSCRIPT_SEGMENT',
      evidence: [{
        kind: 'TRANSCRIPT_SEGMENT',
        transcript_artifact_id: DEMO_TRANSCRIPT_ARTIFACT,
        transcript_revision: 1,
        segment_id: 'a9aa1ed9-4e8e-4d7b-a113-a4e349afd87b',
        quote: '订单表按用户 ID 分成 64 片',
      }],
    }
  }
  return items
}

/**
 * "items 里必须有哪些键"的说明（给模型看的人话；键来自真实 dimensions）。
 * @param {Array<{key: string, label: string, kind: string, weight: number}>} dimensions - 库里读到的真实维度。
 * @returns {{count: number, text: string}} 键数量 + 反引号列表文本。
 */
export function describeExpectedItemKeys(dimensions) {
  const keys = ['transcript_basis', ...dimensions.map((dimension) => dimension.key)]
  return { count: keys.length, text: keys.map((key) => `\`${key}\``).join('、') }
}

/**
 * 展开 goal 文件里的 `{{...}}` 模板（模板内容在**运行时**从库里读，goal 文件不写死版本键）。
 *
 * 支持的 token：
 *   * `{{scorecard_items}}`                          → 合法 items（真实维度键）
 *   * `{{scorecard_items_invalid_evidence_kind}}`    → 负例 items（第一条维度证据 kind 作废）
 *   * `{{scorecard_items_array}}`                    → 负例 items（数组形态）
 *   * `{{dimension_keys_expected}}`                  → 键数量 + 反引号列表
 *   * `{{rubric_ref}}`                               → `rubric v<N> (<rubric_version_id>)`
 *
 * 任何未知 token 一律抛错（防止模板打错字后静默把 `{{...}}` 发给模型）。
 * @param {string} text - goal 原文。
 * @param {{version_no: number, rubric_version_id: string, dimensions: Array<{key: string, label: string, kind: string, weight: number}>}} rubric - 已读到的 pin rubric。
 * @returns {string} 展开后的 goal；没有 token 时原样返回（并保持调用方行为不变）。
 */
export function expandGoalTemplates(text, rubric) {
  /** @type {Record<string, () => string>} */
  const tokens = {
    scorecard_items: () => JSON.stringify(scorecardItemsFromDimensions(rubric.dimensions)),
    scorecard_items_invalid_evidence_kind: () => JSON.stringify(scorecardItemsWithInvalidEvidenceKind(rubric.dimensions)),
    scorecard_items_array: () => JSON.stringify([{ dimension_key: rubric.dimensions[0]?.key ?? 'missing_dimension', assessment: 'MET' }]),
    dimension_keys_expected: () => {
      const expected = describeExpectedItemKeys(rubric.dimensions)
      return `${expected.count} 个键 —— ${expected.text}`
    },
    rubric_ref: () => `rubric v${rubric.version_no}（${rubric.rubric_version_id}）`,
  }
  return text.replace(/\{\{([a-z_]+)\}\}/g, (match, name) => {
    const expand = tokens[name]
    if (expand === undefined) throw new Error(`未知 goal 模板 token：${match}（可用：${Object.keys(tokens).join(', ')}）`)
    return expand()
  })
}

/**
 * goal 文本里是否还有模板 token（run-headless 用来决定是否需要连库展开）。
 * @param {string} text - goal 原文。
 * @returns {boolean} 是否含 `{{...}}`。
 */
export function hasGoalTemplates(text) {
  return /\{\{[a-z_]+\}\}/.test(text)
}
