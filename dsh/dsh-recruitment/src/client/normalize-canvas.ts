import type { ActionView } from './recruiting/view-model.ts';

/**
 * Pure normalization functions for the Recruitment OS v4 right-hand Canvas.
 * Transforms real host HTTP JSON responses (application-detail.json, job-detail.json)
 * into clean, UI-ready view models without exposing raw UUIDs, internal field names,
 * hashes, or protocol jargon.
 */

export type MatchLevel = 'green' | 'amber' | 'red';

export interface FactLabelChip {
  dimension: '来源' | '触发' | '连接';
  raw: string;
  tone: 'neutral' | 'green' | 'amber' | 'red';
}

export interface CriterionVM {
  key: string;
  label: string;
  kindLabel: '硬性' | '加分';
  weightText: string;
  statusText: string;
  level: MatchLevel;
  question?: string;
}

export interface ResumeLineVM {
  id: string;
  matchKey: string;
  heading?: string;
  period?: string;
  body: string;
  pageLabel?: string;
}

export interface ResumeSectionVM {
  title: string;
  items: ResumeLineVM[];
}

export interface TranscriptItemVM {
  id: string;
  matchKey: string;
  timestamp?: string;
  summary: string;
  context?: string;
}

export interface InterviewerVM {
  displayName: string;
  roleLabel: string;
  scorecardStatus: string;
  submitted: boolean;
}

export interface InterviewRoundVM {
  id: string;
  interviewId?: string;
  /** 面试行的 record_version（乐观锁按行，不能拿申请版本顶）。 */
  recordVersion: number;
  leadActorId?: string;
  minuteToken?: string;
  roundLabel: string;
  statusText: string;
  statusTone: 'done' | 'caution' | 'now';
  scheduleText: string;
  detailText: string;
  scorecardsSummary: string;
  overdueCount: number;
  interviewers: InterviewerVM[];
  transcriptStateLabel: string;
}

export interface ScreeningBasisVM {
  label: string;
  detail: string;
}

/** 自动初筛建议（只读、非决定）：HR 不点"发起初筛评估"也应可见。 */
export interface AutoScreeningVM {
  verdict: string;
  verdictLabel: string;
  verdictTone: 'green' | 'amber' | 'red' | '';
  verdictSummary: string;
  advisoryNote: string;
  reasons: readonly {
    readonly code: string;
    readonly criterionKey: string;
    readonly triState: string;
    readonly outcome: string;
    readonly message: string;
  }[];
  summaryText: string;
}

export interface TimelineItemVM {
  id: string;
  timeText: string;
  label: string;
}

export interface ActionNoticeVM {
  key: string;
  label: string;
  available: boolean;
  reason?: string;
}

export interface CandidateCanvasVM {
  applicationId: string;
  shortRef: string;
  candidateName: string;
  jobId: string;
  jobCode: string;
  jobTitle: string;
  lifecycleLabel: string;
  stageCode: string;
  stageLabel: string;
  isScreeningStage: boolean;
  isArchived: boolean;
  recordVersion: number;
  starred: boolean;
  missingScorecardNames: string[];
  stageBlockedReason: string | null;
  nextStepLabel: string | null;
  rubricVersionLabel: string;
  factLabels: FactLabelChip[];
  summaryText: string;
  criteria: CriterionVM[];
  hasResumeMaterial: boolean;
  materialFileName: string | null;
  materialContentUrl: string | null;
  resumeSections: ResumeSectionVM[];
  hasTranscript: boolean;
  transcriptItems: TranscriptItemVM[];
  rounds: InterviewRoundVM[];
  screeningBasis: ScreeningBasisVM[];
  autoScreening: AutoScreeningVM | null;
  timeline: TimelineItemVM[];
  actions: Record<string, ActionView>;
  unavailableActions: ActionNoticeVM[];
}

export interface JobStageNodeVM {
  label: string;
  count: number;
  state: 'done' | 'now' | 'wait' | '';
}

export interface JobApplicationRowVM {
  applicationId: string;
  shortRef: string;
  candidateName: string;
  stageCode: string;
  stageLabel: string;
  filterBucket: '接入' | '初筛' | '面试中' | '终审与 Offer' | '已结束';
  nextStepLabel: string;
  statusTone: 'red' | 'amber' | 'iris' | 'green' | '';
  metaText: string;
}

export interface JobCanvasVM {
  jobId: string;
  jobCode: string;
  title: string;
  departmentId: string;
  departmentName: string;
  statusLabel: string;
  rubricVersionId: string;
  rubricVersionLabel: string;
  rubricApproved: boolean;
  factLabels: FactLabelChip[];
  totalApplications: number;
  activeApplications: number;
  nextStepLabel: string | null;
  stageTrack: JobStageNodeVM[];
  rubricDimensions: CriterionVM[];
  descriptionMd: string;
  requirementsMd: string;
  applications: JobApplicationRowVM[];
  actions: Record<string, ActionView>;
}

// ---------------- Helpers ----------------

const STAGE_LABEL_MAP: Record<string, string> = {
  S1: '需求立项',
  S2: '职位发布',
  S3: '岗位标准',
  S4: '寻访触达',
  S5: '候选人投递',
  S6: '简历接入',
  S7: '初筛评估',
  S8: '面试安排',
  S9: '面试记录',
  S10: '三面终审',
  S11: 'Offer 待确认',
  S12: '录用归档',
};

const LIFECYCLE_LABEL_MAP: Record<string, string> = {
  ACTIVE: '推进中',
  ARCHIVED: '已归档',
  CLOSED: '已结束',
  REJECTED: '已结束',
  HIRED: '已录用',
  WITHDRAWN: '候选人退出',
};

const FIELD_LABEL_MAP: Record<string, string> = {
  name: '姓名',
  email: '邮箱',
  phone: '电话',
  education: '教育背景',
  work_experience: '工作经历',
};

const ACTION_LABEL_MAP: Record<string, string> = {
  screening_decide: '初筛拍板',
  interview_schedule: '安排面试',
  transcript_import: '导入妙记',
  stage_advance: '推进阶段',
  decision_record: '记录决策',
  rubric_approve: '确认岗位标准',
  recruiting_settings_write: '修改招聘设置',
};

const BASIS_KIND_MAP: Record<string, string> = {
  RUBRIC_VERSION: '岗位考核标准',
  AUTHORITY: '操作人权限校验',
  SCREENING_EVALUATION: '简历初筛评估',
};

const AUTO_SCREENING_VERDICT_LABELS: Record<string, string> = {
  PASS: '建议通过',
  FAIL: '建议不通过',
  NEEDS_REVIEW: '建议人工复核',
};
const AUTO_SCREENING_VERDICT_TONES: Record<string, 'green' | 'amber' | 'red' | ''> = {
  PASS: 'green',
  FAIL: 'red',
  NEEDS_REVIEW: 'amber',
};
const AUTO_SCREENING_DEFAULT_NOTE = '这是只读评估给出的建议，不是录用决定；请由招聘团队成员确认。';

/** 归一化服务端 `application.auto_screening`（只读建议，非决定）。 */
function normalizeAutoScreeningVM(value: unknown): AutoScreeningVM | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const verdict = asStr(obj.verdict);
  const verdictSummary = asStr(obj.verdict_summary);
  if (!verdict && !verdictSummary && !asStr(obj.advisory_note)) return null;
  const verdictLabel = AUTO_SCREENING_VERDICT_LABELS[verdict] || (verdict ? verdict : '建议待定');
  const advisoryNote = asStr(obj.advisory_note) || AUTO_SCREENING_DEFAULT_NOTE;
  const reasons = (Array.isArray(obj.reasons) ? obj.reasons : []).map((item) => {
    const r = asObj(item);
    return {
      code: asStr(r.code),
      criterionKey: asStr(r.criterion_key),
      triState: asStr(r.tri_state),
      outcome: asStr(r.outcome),
      message: asStr(r.message),
    };
  });
  return {
    verdict,
    verdictLabel,
    verdictTone: AUTO_SCREENING_VERDICT_TONES[verdict] || '',
    verdictSummary,
    advisoryNote,
    reasons,
    summaryText: [verdictLabel, verdictSummary, advisoryNote].filter(Boolean).join(' · '),
  };
}

const INTERVIEW_STATUS_MAP: Record<string, { text: string; tone: 'done' | 'caution' | 'now' }> = {
  COMPLETED: { text: '已完成', tone: 'done' },
  POST_INTERVIEW: { text: '待收面评', tone: 'caution' },
  SCHEDULED: { text: '已排期', tone: 'now' },
  IN_PROGRESS: { text: '进行中', tone: 'now' },
  CANCELLED: { text: '已取消', tone: 'caution' },
  NO_SHOW: { text: '未出席', tone: 'caution' },
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function normalizeActionMap(rawActions: Record<string, unknown>): Record<string, ActionView> {
  const actions: Record<string, ActionView> = {};
  for (const [key, val] of Object.entries(rawActions)) {
    const a = asObj(val);
    const seam = asStr(a.seam).trim();
    const available = a.available === true && seam !== '';
    const pending = asStr(a.pending).trim();
    const reasonText =
      asStr(a.reason).trim() ||
      asStr(a.blocked_reason).trim() ||
      asStr(a.reason_text).trim() ||
      (pending !== '' ? `待后端接入（${pending}）` : '');
    actions[key] = {
      key,
      label: ACTION_LABEL_MAP[key] || key,
      available,
      seam: available ? seam : '',
      pending: available ? '' : pending,
      pendingText: available ? '' : pending !== '' ? `待后端接入（pending: ${pending}）` : reasonText,
      reasonText,
    };
  }
  return actions;
}

/** Never expose full 36-char UUIDs in UI; return first 8 chars or business code. */
export function shortId(id?: unknown): string {
  const s = asStr(id).trim();
  if (!s) return '—';
  return s.length > 8 ? s.slice(0, 8) : s;
}

export function formatStageLabel(code?: unknown): string {
  const c = asStr(code).toUpperCase();
  return STAGE_LABEL_MAP[c] || '推进中';
}

export function formatShortDateTime(iso?: unknown): string {
  const raw = asStr(iso);
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

/**
 * External fact labels MUST be displayed verbatim without beautification
 * (LIVE/FIXTURE, EVENT/MANUAL, CONNECTED/NOT_CONNECTED/AUTH_REQUIRED).
 */
export function formatFactLabels(rawLabels: unknown): FactLabelChip[] {
  const l = asObj(rawLabels);
  const chips: FactLabelChip[] = [];

  const prov = asStr(l.provenance);
  if (prov) {
    chips.push({
      dimension: '来源',
      raw: prov,
      tone: prov === 'LIVE' ? 'green' : 'amber',
    });
  }

  const trig = asStr(l.trigger);
  if (trig) {
    chips.push({
      dimension: '触发',
      raw: trig,
      tone: 'neutral',
    });
  }

  const conn = asStr(l.connection);
  if (conn) {
    chips.push({
      dimension: '连接',
      raw: conn,
      tone: conn === 'CONNECTED' ? 'green' : conn === 'AUTH_REQUIRED' ? 'amber' : 'red',
    });
  }

  return chips;
}

function mapDimensionToCriterion(
  dimRaw: unknown,
  fieldStates: Record<string, unknown>,
  screeningVerdict: string,
): CriterionVM {
  const d = asObj(dimRaw);
  const key = asStr(d.key, 'dim');
  const kind = asStr(d.kind, 'MUST_HAVE');
  const label = asStr(d.label, '考核维度');
  const weight = asNum(d.weight, 0);
  const weightText = weight > 0 ? `权重 ${Math.round(weight * 100)}%` : '';
  const question = asStr(d.question) || undefined;

  let statusText = '待核实';
  let level: MatchLevel = 'amber';

  if (key.includes('work')) {
    const st = asStr(fieldStates.work_experience);
    if (st === 'present') {
      statusText = '已匹配';
      level = 'green';
    } else if (st === 'absent') {
      statusText = '未提及';
      level = 'red';
    }
  } else if (key.includes('edu')) {
    const st = asStr(fieldStates.education);
    if (st === 'present') {
      statusText = '已匹配';
      level = 'green';
    } else if (st === 'absent') {
      statusText = '未提及';
      level = 'red';
    }
  } else if (screeningVerdict === 'PASS') {
    statusText = kind === 'NICE_TO_HAVE' ? '需面试核实' : '已匹配';
    level = kind === 'NICE_TO_HAVE' ? 'amber' : 'green';
  } else if (screeningVerdict === 'FAIL' || screeningVerdict === 'REJECT') {
    statusText = '未匹配';
    level = 'red';
  }

  return {
    key,
    label,
    kindLabel: kind === 'MUST_HAVE' ? '硬性' : '加分',
    weightText,
    statusText,
    level,
    question,
  };
}

function inferMatchKeyForField(field: string, criteria: CriterionVM[]): string {
  if (field === 'work_experience') {
    return criteria.find((c) => c.key.includes('work'))?.key || criteria[0]?.key || 'work';
  }
  if (field === 'education') {
    return criteria.find((c) => c.key.includes('edu'))?.key || criteria[0]?.key || 'edu';
  }
  return criteria[0]?.key || 'general';
}

function normalizeStageBucket(stageCode: string, lifecycle: string): JobApplicationRowVM['filterBucket'] {
  if (lifecycle !== 'ACTIVE' || stageCode === 'S12') return '已结束';
  if (stageCode === 'S6' || stageCode === 'S5') return '接入';
  if (stageCode === 'S7') return '初筛';
  if (stageCode === 'S8' || stageCode === 'S9') return '面试中';
  return '终审与 Offer';
}

// ---------------- Main Normalizers ----------------

export function normalizeApplicationDetail(raw: unknown): CandidateCanvasVM {
  const root = asObj(raw);
  const app = asObj(root.application);
  const cand = asObj(app.candidate);
  const job = asObj(app.job);
  const appRubric = asObj(app.rubric);
  const material = asObj(app.material);
  const screening = asObj(app.screening);
  const autoScreening = normalizeAutoScreeningVM(app.auto_screening);
  const screeningEval = asObj(screening.evaluation);
  const progress = asObj(app.progress);
  const nextStep = asObj(progress.next_step);
  const resumeObj = asObj(root.resume);
  const screeningEv = asObj(root.screening_evidence);
  const evRubric = asObj(screeningEv.rubric);

  const applicationId = asStr(app.application_id);
  const stageCode = asStr(app.current_stage_code, 'S7');
  const lifecycle = asStr(app.lifecycle_status, 'ACTIVE');
  const verdict = asStr(screeningEval.verdict);
  const fieldStates = asObj(material.field_states);

  const rawDims = asArr(evRubric.dimensions);
  const criteria: CriterionVM[] = rawDims.map((d) => mapDimensionToCriterion(d, fieldStates, verdict));

  // Build resume sections from real API fields (work_entries, education_entries, evidence_samples, fields)
  const resumeSections: ResumeSectionVM[] = [];
  const workEntries = asArr(resumeObj.work_entries);
  const eduEntries = asArr(resumeObj.education_entries);
  const evidenceSamples = asArr(resumeObj.evidence_samples);
  const resumeFields = asArr(resumeObj.fields);

  if (workEntries.length > 0) {
    const matchKey = inferMatchKeyForField('work_experience', criteria);
    resumeSections.push({
      title: '工作经历',
      items: workEntries.map((item, idx) => {
        const w = asObj(item);
        const company = asStr(w.company, '未具名公司');
        const title = asStr(w.title);
        const start = asStr(w.start);
        const end = asStr(w.end, '至今');
        return {
          id: `work-${idx}`,
          matchKey,
          heading: title ? `${company} · ${title}` : company,
          period: start ? `${start} – ${end}` : '',
          body: title ? `担任 ${title}` : '已在简历原件中提取工作经历条目。',
        };
      }),
    });
  }

  if (eduEntries.length > 0) {
    const matchKey = inferMatchKeyForField('education', criteria);
    resumeSections.push({
      title: '教育背景',
      items: eduEntries.map((item, idx) => {
        const e = asObj(item);
        const start = asStr(e.start);
        const end = asStr(e.end);
        return {
          id: `edu-${idx}`,
          matchKey,
          period: start ? `${start}${end ? ` – ${end}` : ''}` : '',
          body: asStr(e.text, '已提取教育背景条目'),
        };
      }),
    });
  }

  if (evidenceSamples.length > 0) {
    resumeSections.push({
      title: '简历原文摘录（可点击标准联动定位）',
      items: evidenceSamples.map((item, idx) => {
        const ev = asObj(item);
        const field = asStr(ev.field);
        const page = asNum(ev.page, 0);
        return {
          id: `ev-${idx}`,
          matchKey: inferMatchKeyForField(field, criteria),
          heading: FIELD_LABEL_MAP[field] || '原文片段',
          pageLabel: page > 0 ? `第 ${page} 页` : undefined,
          body: asStr(ev.quote, ''),
        };
      }),
    });
  }

  const contactItems = resumeFields
    .map((f) => asObj(f))
    .filter((f) => f.state === 'present' && asStr(f.value_preview) && !['work_experience', 'education'].includes(asStr(f.key)));
  if (contactItems.length > 0) {
    resumeSections.push({
      title: '基础提取信息',
      items: contactItems.map((f, idx) => ({
        id: `fld-${idx}`,
        matchKey: criteria[0]?.key || 'general',
        heading: FIELD_LABEL_MAP[asStr(f.key)] || '基本信息',
        body: asStr(f.value_preview),
      })),
    });
  }

  const resumeMaterial = Object.keys(asObj(resumeObj.material)).length > 0 ? asObj(resumeObj.material) : material;
  const assetId = asStr(resumeMaterial.asset_id) || asStr(resumeMaterial.resume_version_id);
  const materialFileName = asStr(resumeMaterial.file_name) || null;
  const hasResumeMaterial = Boolean(assetId || materialFileName || resumeSections.length > 0);

  // Transcript runs (empty array => hasTranscript = false, never crash)
  const rawTranscripts = asArr(root.transcript_runs);
  const transcriptItems: TranscriptItemVM[] = rawTranscripts.map((tr, idx) => {
    const t = asObj(tr);
    return {
      id: `tr-${idx}`,
      matchKey: criteria[0]?.key || 'general',
      timestamp: asStr(t.timestamp) || formatShortDateTime(t.created_at) || undefined,
      summary: asStr(t.summary) || asStr(t.text) || '已同步面试转写记录',
      context: asStr(t.context) || asStr(t.quote) || undefined,
    };
  });

  // Interviews -> sequential rounds (never average scores!)
  const rawInterviews = asArr(app.interviews);
  const rounds: InterviewRoundVM[] = rawInterviews.map((item, idx) => {
    const iv = asObj(item);
    const roundNo = asNum(iv.round_no, idx + 1);
    const status = asStr(iv.status, 'SCHEDULED');
    const stInfo = INTERVIEW_STATUS_MAP[status] || { text: '进行中', tone: 'now' as const };
    const sc = asObj(iv.scorecards);
    const reqTotal = asNum(sc.required_total, 0);
    const subTotal = asNum(sc.submitted, 0);
    const overdue = asNum(sc.overdue, 0);
    const tr = asObj(iv.transcript);
    const trState = asStr(tr.state, 'MISSING');
    const minuteToken = asStr(tr.minute_token) || undefined;

    const interviewers: InterviewerVM[] = asArr(iv.interviewers).map((p) => {
      const ivp = asObj(p);
      const hasSc = Boolean(ivp.scorecard);
      return {
        displayName: asStr(ivp.display_name, '面试官'),
        roleLabel: asStr(ivp.role_in_interview) === 'LEAD' ? '主面试官' : '面试官',
        scorecardStatus: hasSc ? '已交面评' : '待交面评',
        submitted: hasSc,
      };
    });

    const startStr = formatShortDateTime(iv.scheduled_start_at);
    const roundFocus = asObj(iv.round_focus);
    const detailText =
      asStr(roundFocus.reason) ||
      (interviewers.length > 0
        ? `面试官：${interviewers.map((x) => x.displayName).join('、')}`
        : '面试安排已创建');

    return {
      id: shortId(iv.interview_id) || `r-${roundNo}`,
      interviewId: asStr(iv.interview_id) || undefined,
      recordVersion: asNum(iv.record_version, 1),
      leadActorId: asStr(asObj(asArr(iv.interviewers)[0]).actor_id) || undefined,
      minuteToken,
      roundLabel: `第 ${roundNo} 轮面试`,
      statusText: stInfo.text,
      statusTone: stInfo.tone,
      scheduleText: startStr || '时间待定',
      detailText,
      scorecardsSummary: reqTotal > 0 ? `面评 ${subTotal}/${reqTotal}` : '暂无面评要求',
      overdueCount: overdue,
      interviewers,
      transcriptStateLabel: trState === 'MISSING' ? '还没有转录' : '已同步转录',
    };
  });

  // Screening basis (human-readable, no raw hashes or UUIDs)
  const rawBasis = asArr(screeningEv.basis);
  const screeningBasis: ScreeningBasisVM[] = rawBasis.map((b) => {
    const bo = asObj(b);
    const kind = asStr(bo.kind);
    const detail = asObj(bo.detail);
    let text = '已通过系统核验';
    if (kind === 'RUBRIC_VERSION') {
      const vno = asNum(detail.version_no, asNum(evRubric.version_no, 1));
      text = `依据已锁定的岗位标准 V${vno} 执行对照`;
    } else if (kind === 'AUTHORITY') {
      const by = asStr(screening.decided_by_display_name, '招聘团队成员');
      text = `由 ${by} 确认并记录`;
    } else if (kind === 'SCREENING_EVALUATION') {
      const vd = asStr(detail.verdict, verdict);
      text = vd === 'PASS' ? '简历初筛评估结论为：通过' : vd ? '已完成简历初筛评估' : '等待初筛评估结论';
    }
    return {
      label: BASIS_KIND_MAP[kind] || '评估依据',
      detail: text,
    };
  });

  // Timeline
  const timeline: TimelineItemVM[] = asArr(root.timeline).map((ev, idx) => {
    const e = asObj(ev);
    return {
      id: `tl-${idx}`,
      timeText: formatShortDateTime(e.at),
      label: asStr(e.label, '状态更新'),
    };
  });

  // Actions: preserve authoritative ActionView { key, seam, available } + unavailable notices
  const rawActions = asObj(root.actions);
  const actions = normalizeActionMap(rawActions);
  const unavailableActions: ActionNoticeVM[] = Object.entries(rawActions)
    .map(([key, val]) => {
      const a = asObj(val);
      const available = a.available !== false;
      const reason = asStr(a.reason) || asStr(a.blocked_reason) || (a.pending ? '已有待处理操作进行中' : undefined);
      return {
        key,
        label: ACTION_LABEL_MAP[key] || key,
        available,
        reason,
      };
    })
    .filter((a) => !a.available);

  const summaryParts: string[] = [];
  if (asStr(screening.reason)) summaryParts.push(`初筛结论：${asStr(screening.reason)}`);
  // 自动初筛建议（非决定）：即使没有人工初筛决定，也把只读评估摘要摆到最前面。
  if (autoScreening) summaryParts.push(`自动初筛${autoScreening.verdictLabel}（建议）：${autoScreening.verdictSummary}`);
  if (asStr(nextStep.label)) summaryParts.push(asStr(nextStep.label));
  if (summaryParts.length === 0) {
    summaryParts.push(`当前处于「${formatStageLabel(stageCode)}」阶段。`);
  }

  const rubricVersionNo = asNum(appRubric.version_no, asNum(evRubric.version_no, 1));
  const missingScorecardNames = Array.from(
    new Set(
      rounds.flatMap((rd) => rd.interviewers.filter((p) => !p.submitted).map((p) => p.displayName)),
    ),
  );

  return {
    applicationId,
    shortRef: shortId(applicationId),
    candidateName: asStr(cand.display_name, '候选人'),
    jobId: asStr(job.job_id),
    jobCode: asStr(job.code, shortId(job.job_id)),
    jobTitle: asStr(job.title, '在招岗位'),
    lifecycleLabel: LIFECYCLE_LABEL_MAP[lifecycle] || '推进中',
    stageCode,
    stageLabel: formatStageLabel(stageCode),
    isScreeningStage: stageCode === 'S6' || stageCode === 'S7',
    isArchived: lifecycle !== 'ACTIVE' || stageCode === 'S12',
    recordVersion: asNum(app.record_version, 1),
    starred: Boolean(app.starred),
    missingScorecardNames,
    stageBlockedReason: asStr(app.stage_blocked_reason) || null,
    nextStepLabel: asStr(nextStep.label) || null,
    rubricVersionLabel: `V${rubricVersionNo}`,
    factLabels: formatFactLabels(root.labels),
    summaryText: summaryParts.join(' · '),
    criteria,
    hasResumeMaterial,
    materialFileName,
    materialContentUrl: assetId ? `/recruitment/api/material/${encodeURIComponent(assetId)}/content` : null,
    resumeSections,
    hasTranscript: transcriptItems.length > 0,
    transcriptItems,
    rounds,
    screeningBasis,
    autoScreening,
    timeline,
    actions,
    unavailableActions,
  };
}

export function normalizeJobDetail(raw: unknown): JobCanvasVM {
  const root = asObj(raw);
  const job = asObj(root.job);
  const jobRubric = asObj(job.rubric);
  const rootRubric = asObj(root.rubric);
  const appCounts = asObj(job.application_counts);
  const byStage = asObj(appCounts.by_stage);
  const nextStep = asObj(job.next_step);

  const rubricVersionNo = asNum(rootRubric.version_no, asNum(jobRubric.version_no, 1));
  const rubricApproved = Boolean(jobRubric.approved);

  const sIntake = asNum(byStage.S6, 0) + asNum(byStage.S5, 0);
  const sScreen = asNum(byStage.S7, 0);
  const sInterview = asNum(byStage.S8, 0) + asNum(byStage.S9, 0);
  const sFinal = asNum(byStage.S10, 0);
  const sOffer = asNum(byStage.S11, 0) + asNum(byStage.S12, 0);

  const activeStepIdx = sOffer > 0 ? 5 : sFinal > 0 ? 4 : sInterview > 0 ? 3 : sScreen > 0 ? 2 : sIntake > 0 ? 1 : 0;
  const trackMeta: Array<{ label: string; count: number }> = [
    { label: '标准', count: rubricApproved ? 1 : 0 },
    { label: '接入', count: sIntake },
    { label: '初筛', count: sScreen },
    { label: '面试', count: sInterview },
    { label: '终审', count: sFinal },
    { label: 'Offer', count: sOffer },
  ];

  const stageTrack: JobStageNodeVM[] = trackMeta.map((item, idx) => {
    let state: JobStageNodeVM['state'] = '';
    if (idx < activeStepIdx) state = 'done';
    else if (idx === activeStepIdx) state = sScreen > 0 || sFinal > 0 ? 'wait' : 'now';
    return { label: item.label, count: item.count, state };
  });

  const rubricDimensions: CriterionVM[] = asArr(rootRubric.dimensions).map((d) =>
    mapDimensionToCriterion(d, {}, ''),
  );

  const applications: JobApplicationRowVM[] = asArr(root.applications).map((item) => {
    const a = asObj(item);
    const c = asObj(a.candidate);
    const prog = asObj(a.progress);
    const ns = asObj(prog.next_step);
    const stageCode = asStr(a.current_stage_code, 'S6');
    const lifecycle = asStr(a.lifecycle_status, 'ACTIVE');
    const stageLabel = formatStageLabel(stageCode);
    const filterBucket = normalizeStageBucket(stageCode, lifecycle);

    let statusTone: JobApplicationRowVM['statusTone'] = 'iris';
    if (filterBucket === '已结束') statusTone = '';
    else if (stageCode === 'S10') statusTone = 'amber';
    else if (stageCode === 'S11' || stageCode === 'S12') statusTone = 'green';

    const mat = asObj(a.material);
    const entryCounts = asObj(mat.entry_counts);
    const metaParts: string[] = [];
    if (asNum(entryCounts.work, 0) > 0) metaParts.push(`${asNum(entryCounts.work)} 段工作经历`);
    if (asNum(entryCounts.education, 0) > 0) metaParts.push(`${asNum(entryCounts.education)} 段教育背景`);
    if (asStr(ns.label)) metaParts.push(asStr(ns.label));

    return {
      applicationId: asStr(a.application_id),
      shortRef: shortId(a.application_id),
      candidateName: asStr(c.display_name, '候选人'),
      stageCode,
      stageLabel,
      filterBucket,
      nextStepLabel: asStr(ns.label),
      statusTone,
      metaText: metaParts.join(' · ') || '点击查看完整档案',
    };
  });

  const statusMap: Record<string, string> = {
    OPEN: '招聘中',
    PAUSED: '已暂停',
    CLOSED: '已关闭',
    DRAFT: '草稿',
  };

  return {
    jobId: asStr(job.job_id),
    jobCode: asStr(job.code, shortId(job.job_id)),
    title: asStr(job.title, '未命名岗位'),
    departmentId: asStr(job.department_id, ''),
    departmentName: asStr(job.department_name, '招聘团队'),
    statusLabel: statusMap[asStr(job.status)] || '招聘中',
    rubricVersionId: asStr(rootRubric.rubric_version_id, asStr(jobRubric.rubric_version_id, '')),
    rubricVersionLabel: `V${rubricVersionNo}`,
    rubricApproved,
    factLabels: formatFactLabels(root.labels),
    totalApplications: asNum(appCounts.total, applications.length),
    activeApplications: asNum(appCounts.active, applications.length),
    nextStepLabel: asStr(nextStep.label) || null,
    stageTrack,
    rubricDimensions,
    descriptionMd: asStr(job.description_md, ''),
    requirementsMd: asStr(job.requirements_md, ''),
    applications,
    actions: normalizeActionMap(asObj(root.actions)),
  };
}
