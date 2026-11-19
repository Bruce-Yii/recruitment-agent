import React, { useEffect, useState } from 'react';
import type { CandidateCanvasVM } from '../normalize-canvas.ts';
import type { ActionView } from '../recruiting/view-model.ts';
import {
  blockerTextOf,
  buildDecisionRecordBody,
  buildInterviewScheduleBody,
  buildScreeningDecisionBody,
  buildStageAdvanceBody,
  buildTranscriptImportBody,
  decisionRecordBlockers,
  describeActionError,
  fetchDecisionFacts,
  fetchInterviewFreeSlots,
  getCanvasSessionId,
  newIdempotencyKey,
  postActionSeam,
  postApplicationTransfer,
  postCandidateConstraint,
  postDecisionRecordFacade,
  postEmailSend,
  screeningDecisionBlockers,
  toOffsetIso,
  type ActionOutcome,
  type CanvasActionError,
  type DecisionFactsResource,
  type FreeSlotsResult,
} from './canvas-actions.ts';

export type CandidateModalKind =
  | 'pin'
  | 'handoff'
  | 'transfer'
  | 'schedule'
  | 'screening'
  | 'decision'
  | 'stage_advance'
  | 'transcript_import'
  | 'no_show'
  | 'email';

export interface CandidateModalSuccess {
  message: string;
  actionId?: string;
  rebindPrompt?: {
    interviewId: string;
    fromActorId: string;
    toActorId: string;
    minuteToken: string;
  };
}

export interface CandidateActionModalProps {
  kind: CandidateModalKind;
  vm: CandidateCanvasVM;
  sessionId?: string;
  onClose: () => void;
  onSuccess: (result: CandidateModalSuccess) => void;
}

const DEFAULT_CONFIRM_MAP = (kind: CandidateModalKind, name: string): string => {
  switch (kind) {
    case 'pin': return `确认置顶 ${name} 的关键约束`;
    case 'handoff': return `确认为 ${name} 留下下一轮面试交接追问`;
    case 'transfer': return `确认将 ${name} 跨岗调剂`;
    case 'schedule': return `确认为 ${name} 安排或改期面试`;
    case 'screening': return `确认记录 ${name} 的初筛结论`;
    case 'decision': return `确认记录 ${name} 的终审正式决策`;
    case 'stage_advance': return `确认推进 ${name} 的招聘阶段`;
    case 'transcript_import': return `确认导入 ${name} 的面试转写`;
    case 'no_show': return `确认标记 ${name} 本场面试未出席`;
    case 'email': return `确认向 ${name} 发送邮件`;
  }
};

function needsConfirmationInput(kind: CandidateModalKind): boolean {
  return kind === 'pin' || kind === 'handoff' || kind === 'transfer' || kind === 'email';
}

function formatOutcomeError(outcome: ActionOutcome): string {
  const code = `${outcome.code} ${outcome.reasonCode}`.toUpperCase();
  if (outcome.status === 409 && (code.includes('VERSION') || code.includes('CONFLICT') || code.includes('STALE') || code.includes('LOCK'))) {
    return '这条刚被别人改过，请刷新';
  }
  if (outcome.status === 409 && (code.includes('DUPLICATE') || code.includes('ALREADY') || code.includes('DECISION_EXISTS'))) {
    return '已处理过，不会重复写入';
  }
  if (code.includes('SCORECARD_MISSING')) {
    return '还有面试官尚未提交面评，暂时不能提交终审决策';
  }
  return outcome.message || describeActionError(outcome.code, outcome.reasonCode) || '操作未能完成，请检查输入或稍后重试';
}

function normalizeStartAtIso(raw: string): string {
  const trimmed = raw.trim();
  if (/[+-]\d{2}:\d{2}$|Z$/i.test(trimmed)) return trimmed;
  const converted = toOffsetIso(trimmed);
  return converted || trimmed;
}

function extractOutcomeActionId(outcome: ActionOutcome): string | undefined {
  const payload = outcome.payload;
  if (payload && typeof payload.action_id === 'string' && payload.action_id.trim() !== '') {
    return payload.action_id;
  }
  return undefined;
}

function requireAvailableAction(
  vm: CandidateCanvasVM,
  key: string,
  fallbackLabel: string,
): { ok: true; action: ActionView } | { ok: false; message: string } {
  const action = vm.actions[key];
  if (!action || !action.available || action.seam === '') {
    return {
      ok: false,
      message: action?.reasonText || action?.pendingText || `当前阶段暂不可执行「${fallbackLabel}」`,
    };
  }
  return { ok: true, action };
}

export function CandidateActionModal({ kind, vm, sessionId, onClose, onSuccess }: CandidateActionModalProps) {
  const activeSessionId = (sessionId ?? '').trim() || getCanvasSessionId();
  const latestRound = vm.rounds[vm.rounds.length - 1];
  const defaultActors = vm.rounds.map((r) => r.leadActorId).filter((x): x is string => Boolean(x)).join(',');

  const [inputText, setInputText] = useState('');
  const [confirmText, setConfirmText] = useState(() => DEFAULT_CONFIRM_MAP(kind, vm.candidateName));
  const [targetJobId, setTargetJobId] = useState('');
  const [screenResult, setScreenResult] = useState<'ADVANCE' | 'HOLD' | 'REJECT' | 'WITHDRAW'>('ADVANCE');
  const [decisionScope, setDecisionScope] = useState<'FINAL' | 'STAGE'>('FINAL');
  const [decisionResult, setDecisionResult] = useState<'ADVANCE' | 'HOLD' | 'REJECT'>('ADVANCE');
  const [transcriptSourceKind, setTranscriptSourceKind] = useState<'DEMO_SAMPLE' | 'PLATFORM_EXPORT'>('DEMO_SAMPLE');
  const [exportedFileName, setExportedFileName] = useState('');
  const [noShowSubject, setNoShowSubject] = useState<'CANDIDATE' | 'INTERVIEWER'>('CANDIDATE');
  const [emailTemplate, setEmailTemplate] = useState<'OFFER' | 'INVITE' | 'THANK_YOU'>('OFFER');
  const [emailSubject, setEmailSubject] = useState(`【通知】${vm.jobTitle}（${vm.candidateName}）`);

  const [scheduleIntent, setScheduleIntent] = useState<'CREATE' | 'RESCHEDULE'>(
    vm.rounds.length > 0 ? 'RESCHEDULE' : 'CREATE',
  );
  const [selectedInterviewers, setSelectedInterviewers] = useState(defaultActors);
  const [scheduleTime, setScheduleTime] = useState('');
  const [replaceInterviewer, setReplaceInterviewer] = useState('');
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const [freeSlotsLoading, setFreeSlotsLoading] = useState(kind === 'schedule');
  const [freeSlots, setFreeSlots] = useState<FreeSlotsResult | null>(null);

  // Task 08c: Decision facts prefetch for screening / formal decision
  const needsFacts = kind === 'screening' || kind === 'decision';
  const [factsLoading, setFactsLoading] = useState(needsFacts);
  const [factsRes, setFactsRes] = useState<DecisionFactsResource | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const loadSlots = (rawIds: string) => {
    setFreeSlotsLoading(true);
    const ids = rawIds.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    void fetchInterviewFreeSlots({
      applicationId: vm.applicationId,
      interviewerActorIds: ids,
      days: 5,
      durationMinutes: 45,
    })
      .then((res) => setFreeSlots(res))
      .finally(() => setFreeSlotsLoading(false));
  };

  useEffect(() => {
    if (kind === 'schedule') loadSlots(defaultActors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, vm.applicationId]);

  useEffect(() => {
    if (!needsFacts) return;
    const controller = new AbortController();
    let active = true;
    setFactsLoading(true);
    void fetchDecisionFacts(vm.applicationId, activeSessionId, controller.signal)
      .then((res) => {
        if (!active) return;
        setFactsRes(res);
      })
      .catch(() => {
        if (!active) return;
        setFactsRes({ facts: undefined, probe: 'ERROR', status: 0, error: undefined });
      })
      .finally(() => {
        if (active) setFactsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [needsFacts, vm.applicationId, activeSessionId]);

  const missingForOffer = kind === 'decision' && decisionResult === 'ADVANCE' && vm.missingScorecardNames.length > 0;

  // Compute decision-facts structural blockers (fail-closed: probe !== 'READY' blocks submit)
  let factsBlockedMessage: string | null = null;
  if (needsFacts && !factsLoading) {
    if (!factsRes || factsRes.probe !== 'READY' || !factsRes.facts) {
      factsBlockedMessage =
        kind === 'screening'
          ? '还没有初筛评估，先让 Agent 跑一次初筛'
          : '决策汇总还没有生成，暂时不能提交正式决策';
    } else if (kind === 'screening') {
      const needsEval = screenResult === 'ADVANCE' || screenResult === 'REJECT';
      const blockers = screeningDecisionBlockers(factsRes.facts, needsEval);
      if (blockers.length > 0) {
        factsBlockedMessage = blockers.includes('MISSING_SCREENING_EVALUATION')
          ? '还没有初筛评估，先让 Agent 跑一次初筛'
          : blockers.map((code) => blockerTextOf(code)).join('；');
      }
    } else if (kind === 'decision') {
      const blockers = decisionRecordBlockers(factsRes.facts);
      if (blockers.length > 0) {
        factsBlockedMessage = blockers.map((code) => blockerTextOf(code)).join('；');
      }
    }
  }

  const submitBlocked = submitting || missingForOffer || (needsFacts && (factsLoading || factsBlockedMessage !== null));

  const handleSubmit = async () => {
    if (submitBlocked) return;
    const confirmationText = confirmText.trim();
    if (needsConfirmationInput(kind) && !confirmationText) {
      setErrorText('请先填写确认原话后再提交。');
      return;
    }

    setSubmitting(true);
    setErrorText(null);
    try {
      if (kind === 'pin') {
        if (!inputText.trim()) { setErrorText('请填写需要置顶的约束内容。'); setSubmitting(false); return; }
        const res = await postCandidateConstraint({
          action: 'PIN',
          applicationId: vm.applicationId,
          text: inputText.trim(),
          source: 'CHAT',
          confirmationText,
        });
        onSuccess({ message: '已置顶候选人约束，并同步至档案与面试简报。', actionId: res.action_id });
      } else if (kind === 'handoff') {
        if (!inputText.trim()) { setErrorText('请填写给下一轮面试官的交接追问。'); setSubmitting(false); return; }
        const res = await postCandidateConstraint({
          action: 'HANDOFF',
          applicationId: vm.applicationId,
          interviewId: latestRound?.interviewId,
          text: inputText.trim(),
          source: 'CHAT',
          confirmationText,
        });
        onSuccess({ message: '已写入下一轮交接追问，面试官可第一眼看到。', actionId: res.action_id });
      } else if (kind === 'transfer') {
        if (!targetJobId.trim()) { setErrorText('请填写目标岗位编号。'); setSubmitting(false); return; }
        const res = await postApplicationTransfer({
          applicationId: vm.applicationId,
          targetJobId: targetJobId.trim(),
          confirmationText,
          expectedRecordVersion: vm.recordVersion,
        });
        onSuccess({ message: '已完成跨岗调剂，原岗位档案完整保留。', actionId: res.action_id });
      } else if (kind === 'screening') {
        if (!factsRes || factsRes.probe !== 'READY' || !factsRes.facts) {
          setErrorText('还没有初筛评估，先让 Agent 跑一次初筛');
          setSubmitting(false);
          return;
        }
        const actCheck = requireAvailableAction(vm, 'screening_decide', '记录初筛结论');
        if (!actCheck.ok) { setErrorText(actCheck.message); setSubmitting(false); return; }
        const built = buildScreeningDecisionBody({
          facts: factsRes.facts,
          applicationId: vm.applicationId,
          result: screenResult,
          reason: inputText.trim() || '依据岗位标准完成初筛评估',
        });
        if (!built.ok) { setErrorText(built.reasonText); setSubmitting(false); return; }
        const outcome = await postActionSeam(actCheck.action, built.body, activeSessionId);
        if (!outcome.ok) { setErrorText(formatOutcomeError(outcome)); setSubmitting(false); return; }
        onSuccess({ message: '已记录初筛结论并同步落库。', actionId: extractOutcomeActionId(outcome) });
      } else if (kind === 'decision') {
        if (!factsRes || factsRes.probe !== 'READY' || !factsRes.facts) {
          setErrorText('决策汇总还没有生成，暂时不能提交正式决策');
          setSubmitting(false);
          return;
        }
        const built = buildDecisionRecordBody({
          facts: factsRes.facts,
          applicationId: vm.applicationId,
          scope: decisionScope,
          result: decisionResult,
          reason: inputText.trim() || '综合各轮评估完成正式决策',
        });
        if (!built.ok) { setErrorText(built.reasonText); setSubmitting(false); return; }
        const decisionAction = vm.actions.decision_record;
        if (decisionAction && !decisionAction.available) {
          setErrorText(decisionAction.reasonText || decisionAction.pendingText || '当前阶段暂不可提交正式决策');
          setSubmitting(false);
          return;
        }
        const outcome =
          decisionAction && decisionAction.available && decisionAction.seam !== ''
            ? await postActionSeam(decisionAction, built.body, activeSessionId)
            : await postDecisionRecordFacade(built.body, activeSessionId);
        if (!outcome.ok) { setErrorText(formatOutcomeError(outcome)); setSubmitting(false); return; }
        onSuccess({ message: '已记录终审正式决策并同步落库。', actionId: extractOutcomeActionId(outcome) });
      } else if (kind === 'stage_advance') {
        const actCheck = requireAvailableAction(vm, 'stage_advance', '推进阶段');
        if (!actCheck.ok) { setErrorText(actCheck.message); setSubmitting(false); return; }
        const built = buildStageAdvanceBody({ applicationId: vm.applicationId });
        if (!built.ok) { setErrorText(built.reasonText); setSubmitting(false); return; }
        const outcome = await postActionSeam(actCheck.action, built.body, activeSessionId);
        if (!outcome.ok) { setErrorText(formatOutcomeError(outcome)); setSubmitting(false); return; }
        onSuccess({ message: '已推进候选人阶段。', actionId: extractOutcomeActionId(outcome) });
      } else if (kind === 'transcript_import') {
        if (!inputText.trim()) { setErrorText('请先输入转写文本或飞书妙记内容。'); setSubmitting(false); return; }
        const actCheck = requireAvailableAction(vm, 'transcript_import', '导入转写');
        if (!actCheck.ok) { setErrorText(actCheck.message); setSubmitting(false); return; }
        const built = buildTranscriptImportBody({
          interviewId: latestRound?.interviewId || '',
          content: inputText.trim(),
          sourceKind: transcriptSourceKind,
          exportedFileName: transcriptSourceKind === 'PLATFORM_EXPORT' ? exportedFileName.trim() : undefined,
        });
        if (!built.ok) { setErrorText(built.reasonText); setSubmitting(false); return; }
        const outcome = await postActionSeam(actCheck.action, built.body, activeSessionId);
        if (!outcome.ok) { setErrorText(formatOutcomeError(outcome)); setSubmitting(false); return; }
        onSuccess({ message: '已导入面试转写记录。', actionId: extractOutcomeActionId(outcome) });
      } else if (kind === 'no_show') {
        const actCheck = requireAvailableAction(vm, 'interview_schedule', '标记未出席');
        if (!actCheck.ok) { setErrorText(actCheck.message); setSubmitting(false); return; }
        const body: Record<string, unknown> = {
          intent: 'NO_SHOW',
          application_id: vm.applicationId,
          idempotency_key: idempotencyKey,
          subject: noShowSubject,
          reason: inputText.trim() || '未按约定时间出席面试',
          expected_record_version: vm.recordVersion,
        };
        if (latestRound?.interviewId) body.interview_id = latestRound.interviewId;
        const outcome = await postActionSeam(actCheck.action, body, activeSessionId);
        if (!outcome.ok) { setErrorText(formatOutcomeError(outcome)); setSubmitting(false); return; }
        onSuccess({ message: '已标记本场面试为「未出席」并留痕。', actionId: extractOutcomeActionId(outcome) });
      } else if (kind === 'email') {
        const res = await postEmailSend({
          applicationId: vm.applicationId,
          template: emailTemplate,
          subject: emailSubject.trim() || `关于「${vm.jobTitle}」应聘进展通知`,
          bodyText: inputText.trim() || `您好 ${vm.candidateName}，感谢您参与「${vm.jobTitle}」招聘流程。`,
          confirmationText,
          expectedRecordVersion: vm.recordVersion,
        });
        onSuccess({ message: '已发送邮件并记录外发留痕。', actionId: res.action_id });
      } else if (kind === 'schedule') {
        if (!scheduleTime.trim()) { setErrorText('请选择一个空闲时段，或手动填写面试时间。'); setSubmitting(false); return; }
        const actCheck = requireAvailableAction(vm, 'interview_schedule', '安排面试');
        if (!actCheck.ok) { setErrorText(actCheck.message); setSubmitting(false); return; }
        const isReplace = replaceInterviewer.trim() !== '';
        const ids = selectedInterviewers.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
        const startIso = normalizeStartAtIso(scheduleTime);

        let bodyToSend: Readonly<Record<string, unknown>>;
        if (scheduleIntent === 'CREATE') {
          const built = buildInterviewScheduleBody({
            applicationId: vm.applicationId,
            roundNo: vm.rounds.length + 1,
            scheduledStartAt: startIso,
            durationMinutes: 45,
            interviewers: ids.map((actorId) => ({ actorId })),
            idempotencyKey,
          });
          if (!built.ok) { setErrorText(built.reasonText); setSubmitting(false); return; }
          bodyToSend = built.body;
        } else {
          const rescheduleBody: Record<string, unknown> = {
            intent: isReplace ? 'REPLACE' : 'RESCHEDULE',
            application_id: vm.applicationId,
            scheduled_start_at: startIso,
            duration_minutes: 45,
            idempotency_key: idempotencyKey,
            expected_record_version: vm.recordVersion,
          };
          if (latestRound?.interviewId) rescheduleBody.interview_id = latestRound.interviewId;
          if (isReplace) {
            rescheduleBody.interviewers = [{ actor_id: replaceInterviewer.trim() }];
          } else if (ids.length > 0) {
            rescheduleBody.interviewers = ids.map((actorId) => ({ actor_id: actorId }));
          }
          bodyToSend = rescheduleBody;
        }

        const outcome = await postActionSeam(actCheck.action, bodyToSend, activeSessionId);
        if (!outcome.ok) { setErrorText(formatOutcomeError(outcome)); setSubmitting(false); return; }
        onSuccess({
          message: isReplace ? '已完成改期并更换面试官。' : '已锁定面试时间并同步排期。',
          actionId: extractOutcomeActionId(outcome),
          rebindPrompt:
            isReplace && latestRound?.minuteToken && latestRound.interviewId
              ? {
                  interviewId: latestRound.interviewId,
                  fromActorId: latestRound.leadActorId || '',
                  toActorId: replaceInterviewer.trim(),
                  minuteToken: latestRound.minuteToken,
                }
              : undefined,
        });
      }
    } catch (err) {
      setErrorText((err as CanvasActionError)?.userMessage || (err instanceof Error ? err.message : '这项操作暂时未能完成，请稍后重试。'));
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !submitBlocked) {
        e.preventDefault();
        void handleSubmit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const titleMap: Record<CandidateModalKind, string> = {
    pin: `为 ${vm.candidateName} 置顶约束`,
    handoff: `为 ${vm.candidateName} 留下一轮交接追问`,
    transfer: `跨岗调剂 · ${vm.candidateName}`,
    schedule: `面试排期与改期换人 · ${vm.candidateName}`,
    screening: `记录初筛结论 · ${vm.candidateName}`,
    decision: `记录终审正式决策 · ${vm.candidateName}`,
    stage_advance: `推进阶段 · ${vm.candidateName}`,
    transcript_import: `导入面试转写 · ${vm.candidateName}`,
    no_show: `标记面试未出席 · ${vm.candidateName}`,
    email: `发送邮件 · ${vm.candidateName}`,
  };

  return (
    <div
      className="ros-modal-bg"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="ros-modal">
        <div style={{ fontSize: '17px', fontWeight: 650 }}>{titleMap[kind]}</div>

        {needsFacts && factsLoading ? (
          <div className="ros-sec-meta" data-testid="decision-facts-loading">正在核对服务端决策依据…</div>
        ) : null}

        {needsFacts && !factsLoading && factsBlockedMessage ? (
          <div
            className="ros-risk-note"
            data-testid="decision-facts-blocked"
            style={{ borderLeftColor: 'var(--red)', color: 'var(--red)' }}
          >
            {factsBlockedMessage}
          </div>
        ) : null}

        {kind === 'schedule' ? (
          <>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className={`ros-slot-pill ${scheduleIntent === 'CREATE' ? 'active' : ''}`} onClick={() => setScheduleIntent('CREATE')}>
                安排新场次
              </button>
              <button type="button" data-testid="schedule-mode-reschedule" className={`ros-slot-pill ${scheduleIntent === 'RESCHEDULE' ? 'active' : ''}`} onClick={() => setScheduleIntent('RESCHEDULE')}>
                改期现有场次
              </button>
            </div>
            <label className="ros-m-field">
              <span>选择面试官（支持多个，逗号分隔）</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input data-testid="schedule-interviewers-input" style={{ flex: 1 }} value={selectedInterviewers} onChange={(e) => setSelectedInterviewers(e.target.value)} placeholder="输入面试官编号（多个用逗号分隔）" />
                <button type="button" className="ros-btn" onClick={() => loadSlots(selectedInterviewers)}>查空闲</button>
              </div>
            </label>
            {freeSlotsLoading ? (
              <div className="ros-sec-meta">正在读取飞书日历共同空闲时段…</div>
            ) : freeSlots ? (
              <>
                {freeSlots.unavailableBanner ? <div className="ros-risk-note" data-testid="calendar-unavailable-banner">{freeSlots.unavailableBanner}</div> : null}
                {freeSlots.unsatisfiedReasons.length > 0 ? <div className="ros-risk-note" data-testid="calendar-unsatisfied-banner">{freeSlots.unsatisfiedReasons.join('；')}</div> : null}
                {freeSlots.slots.length > 0 ? (
                  <div className="ros-slot-grid" data-testid="free-slots-grid">
                    {freeSlots.slots.map((slot) => (
                      <button
                        key={slot.startIso}
                        type="button"
                        className={`ros-slot-pill ${scheduleTime === slot.startIso ? 'active' : ''}`}
                        onClick={() => { setScheduleTime(slot.startIso); }}
                      >
                        {slot.label}
                      </button>
                    ))}
                  </div>
                ) : !freeSlots.calendarUnavailable && freeSlots.unsatisfiedReasons.length === 0 ? (
                  <div className="ros-sec-meta" data-testid="free-slots-empty">未来 5 天没有共同空闲，请直接在下方手动填写时间。</div>
                ) : null}
              </>
            ) : null}
            <label className="ros-m-field">
              <span>面试开始时间</span>
              <input data-testid="schedule-time-input" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} placeholder="点选上方时段自动填入，或输入 ISO / 本地时间" />
            </label>
            <label className="ros-m-field">
              <span>更换新面试官（选填）</span>
              <input data-testid="replace-interviewer-input" value={replaceInterviewer} onChange={(e) => setReplaceInterviewer(e.target.value)} placeholder="留空则仅排期/改期" />
            </label>
          </>
        ) : kind === 'screening' ? (
          <>
            <div className="ros-slot-grid">
              {(['ADVANCE', 'HOLD', 'REJECT', 'WITHDRAW'] as const).map((opt) => (
                <button key={opt} type="button" className={`ros-slot-pill ${screenResult === opt ? 'active' : ''}`} onClick={() => setScreenResult(opt)}>
                  {opt === 'ADVANCE' ? '通过' : opt === 'HOLD' ? '待定' : opt === 'REJECT' ? '不通过' : '撤回'}
                </button>
              ))}
            </div>
            <label className="ros-m-field">
              <span>初筛判断理由 / 人工纠偏说明</span>
              <textarea rows={3} value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="说明初筛判断依据…" />
            </label>
          </>
        ) : kind === 'decision' ? (
          <>
            {vm.missingScorecardNames.length > 0 ? (
              <div className="ros-risk-note" data-testid="decision-missing-scorecards" style={{ borderLeftColor: 'var(--red)', color: 'var(--red)' }}>
                还缺 {vm.missingScorecardNames.join('、')} 的面评，暂时不能提交录用决策。
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className={`ros-slot-pill ${decisionScope === 'FINAL' ? 'active' : ''}`} onClick={() => setDecisionScope('FINAL')}>终审决策</button>
              <button type="button" className={`ros-slot-pill ${decisionScope === 'STAGE' ? 'active' : ''}`} onClick={() => setDecisionScope('STAGE')}>阶段决策</button>
            </div>
            <div className="ros-slot-grid">
              {(['ADVANCE', 'HOLD', 'REJECT'] as const).map((opt) => (
                <button key={opt} type="button" className={`ros-slot-pill ${decisionResult === opt ? 'active' : ''}`} onClick={() => setDecisionResult(opt)}>
                  {opt === 'ADVANCE' ? '通过（推进 / 发 Offer）' : opt === 'HOLD' ? '待定' : '不通过'}
                </button>
              ))}
            </div>
            <label className="ros-m-field">
              <span>正式决策理由</span>
              <textarea rows={3} value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="总结各轮评估后的正式决策理由…" />
            </label>
          </>
        ) : kind === 'stage_advance' ? (
          <div className="ros-jd-box" style={{ padding: '12px 14px' }}>
            目标阶段由服务端根据当前已完成事实自动推导并推进，前端不手工覆盖阶段码。
          </div>
        ) : kind === 'transcript_import' ? (
          <>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className={`ros-slot-pill ${transcriptSourceKind === 'DEMO_SAMPLE' ? 'active' : ''}`} onClick={() => setTranscriptSourceKind('DEMO_SAMPLE')}>演示 / 文本粘贴</button>
              <button type="button" className={`ros-slot-pill ${transcriptSourceKind === 'PLATFORM_EXPORT' ? 'active' : ''}`} onClick={() => setTranscriptSourceKind('PLATFORM_EXPORT')}>平台导出件</button>
            </div>
            {transcriptSourceKind === 'PLATFORM_EXPORT' ? (
              <label className="ros-m-field">
                <span>平台导出文件名</span>
                <input value={exportedFileName} onChange={(e) => setExportedFileName(e.target.value)} placeholder="例如：interview-round1-export.txt" />
              </label>
            ) : null}
            <label className="ros-m-field">
              <span>转写正文内容</span>
              <textarea rows={4} value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="粘贴面试转写正文…" />
            </label>
          </>
        ) : kind === 'no_show' ? (
          <>
            <div className="ros-slot-grid">
              <button type="button" className={`ros-slot-pill ${noShowSubject === 'CANDIDATE' ? 'active' : ''}`} onClick={() => setNoShowSubject('CANDIDATE')}>候选人未出席</button>
              <button type="button" className={`ros-slot-pill ${noShowSubject === 'INTERVIEWER' ? 'active' : ''}`} onClick={() => setNoShowSubject('INTERVIEWER')}>面试官未出席</button>
            </div>
            <label className="ros-m-field">
              <span>未出席原因说明</span>
              <input value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="例如：候选人临时爽约未上线" />
            </label>
          </>
        ) : kind === 'email' ? (
          <>
            <div className="ros-slot-grid">
              {(['OFFER', 'INVITE', 'THANK_YOU'] as const).map((tpl) => (
                <button key={tpl} type="button" className={`ros-slot-pill ${emailTemplate === tpl ? 'active' : ''}`} onClick={() => setEmailTemplate(tpl)}>
                  {tpl === 'OFFER' ? '正式 Offer 邮件' : tpl === 'INVITE' ? '面试邀约邮件' : '礼貌婉拒邮件'}
                </button>
              ))}
            </div>
            <label className="ros-m-field">
              <span>邮件主题</span>
              <input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} />
            </label>
            <label className="ros-m-field">
              <span>邮件正文</span>
              <textarea rows={3} value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="输入邮件正文内容…" />
            </label>
          </>
        ) : kind === 'transfer' ? (
          <label className="ros-m-field">
            <span>目标岗位 ID</span>
            <input value={targetJobId} onChange={(e) => setTargetJobId(e.target.value)} placeholder="输入目标岗位 ID（原岗位档案完整保留）" />
          </label>
        ) : (
          <label className="ros-m-field">
            <span>{kind === 'pin' ? '约束内容（≤500 字）' : '给下一轮面试官的交接追问（≤500 字）'}</span>
            <textarea rows={3} maxLength={500} value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder={kind === 'pin' ? '例如：字节 Offer 周五截止 · 期望 45k' : '例如：重点追问并发回滚深度'} />
          </label>
        )}

        {needsConfirmationInput(kind) ? (
          <label className="ros-m-field">
            <span>确认原话（留痕必填）</span>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="输入一句确认原话" />
          </label>
        ) : null}

        {errorText ? (
          <div className="ros-risk-note" style={{ borderLeftColor: 'var(--red)', color: 'var(--red)' }}>{errorText}</div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" className="ros-btn" title="Esc 关闭" disabled={submitting} onClick={onClose}>取消</button>
          <button type="button" className="ros-btn dark" title="⌘/Ctrl + Enter 提交" disabled={submitBlocked} data-testid="canvas-modal-submit" onClick={() => void handleSubmit()}>
            {submitting ? '处理中…' : '确认提交'}
          </button>
        </div>
      </div>
    </div>
  );
}
