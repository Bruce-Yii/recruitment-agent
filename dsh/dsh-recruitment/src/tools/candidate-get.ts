// recruitment_candidate_get —— 按 id 取一个候选人档案（只读，stub 数据）。
//
// 只读证据：本文件不 import 任何 fs / net / DB 模块；execute 只做「按 id 取常量
// + 按开关脱敏」，不修改任何模块级状态。

import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { APPLICATION_STAGES, CANDIDATE_STUBS, CANDIDATE_STATUSES, STUB_PROVENANCE } from './stubs.ts'

/** 入参声明。 */
const PARAMS: ParamMap = {
  candidate_id: {
    kind: 'string',
    required: true,
    maxLength: 64,
    description: 'Candidate identifier, e.g. "candidate_0001". Non-empty, at most 64 characters.',
  },
  include_contacts: {
    kind: 'boolean',
    description: 'When true, return full email/phone. Defaults to false, which masks both.',
  },
}

/** 输出：联系方式。 */
interface Contacts {
  readonly visible: boolean
  readonly email: string
  readonly phone: string
}

/** 输出：一条申请关系。 */
interface ApplicationValue {
  readonly application_id: string
  readonly job_id: string
  readonly stage: string
}

/** 输出：规范值。 */
interface CandidateGetValue {
  readonly candidate_id: string
  readonly display_name: string
  readonly status: string
  readonly provenance: string
  readonly stub: boolean
  readonly contacts: Contacts
  readonly applications: readonly ApplicationValue[]
}

/** 规范输出 schema（只用官方强制子集里的关键字）。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    candidate_id: { type: 'string' },
    display_name: { type: 'string' },
    status: { type: 'string', enum: [...CANDIDATE_STATUSES] },
    provenance: { type: 'string', enum: ['FIXTURE', 'LIVE'] },
    stub: { type: 'boolean' },
    contacts: {
      type: 'object',
      properties: {
        visible: { type: 'boolean' },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['visible', 'email', 'phone'],
      additionalProperties: false,
    },
    applications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          application_id: { type: 'string' },
          job_id: { type: 'string' },
          stage: { type: 'string', enum: [...APPLICATION_STAGES] },
        },
        required: ['application_id', 'job_id', 'stage'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidate_id', 'display_name', 'status', 'provenance', 'stub', 'contacts', 'applications'],
  additionalProperties: false,
}

/**
 * 邮箱脱敏：保留首字母与域名。
 * @param email - 原始邮箱。
 * @returns 脱敏后的邮箱。
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

/**
 * 手机号脱敏：保留前 3 位与后 4 位。
 * @param phone - 原始号码。
 * @returns 脱敏后的号码。
 */
function maskPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '')
  if (digits.length < 8) return '***'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/** 只读候选人工具。 */
export const candidateGetTool: ReadonlyToolDefinition = {
  name: 'recruitment_candidate_get',
  description:
    'Get one candidate profile by id, including its application links. '
    + 'Read-only stub over fixture data: provenance is always FIXTURE and no database is touched. '
    + 'Contacts are masked unless include_contacts is true. Returns NOT_FOUND for an unknown id.',
  parameters: toParameterSchema(PARAMS),
  output: {
    schema: OUTPUT_SCHEMA,
    render(_args: unknown, value: unknown): readonly TextBlock[] {
      const v = value as CandidateGetValue
      const lines: string[] = [
        `candidate ${v.candidate_id} / ${v.display_name} (status=${v.status}, `
          + `provenance=${v.provenance}, stub=${String(v.stub)})`,
        `contacts: ${v.contacts.email} / ${v.contacts.phone} (visible=${String(v.contacts.visible)})`,
        `applications: ${v.applications.length}`,
      ]
      for (const application of v.applications) {
        lines.push(`  ${application.application_id} -> ${application.job_id} @ ${application.stage}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  isConcurrencySafe(): boolean {
    return true
  },
  async execute(rawArgs: unknown): Promise<unknown> {
    const args = parseArgs(PARAMS, rawArgs)
    const candidateId = args.candidate_id as string
    const record = CANDIDATE_STUBS[candidateId]
    if (record === undefined) {
      throw new RecruitmentToolError(
        'NOT_FOUND',
        `candidate "${candidateId}" not found; known stub ids: ${Object.keys(CANDIDATE_STUBS).join(', ')}`,
      )
    }
    const visible = args.include_contacts === true
    const value: CandidateGetValue = {
      candidate_id: record.candidate_id,
      display_name: record.display_name,
      status: record.status,
      provenance: STUB_PROVENANCE,
      stub: true,
      contacts: {
        visible,
        email: visible ? record.email : maskEmail(record.email),
        phone: visible ? record.phone : maskPhone(record.phone),
      },
      applications: record.applications.map((application) => ({
        application_id: application.application_id,
        job_id: application.job_id,
        stage: application.stage,
      })),
    }
    return value
  },
}
