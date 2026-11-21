import React, { useEffect, useMemo, useState } from 'react';
import { normalizeApplicationDetail, type CandidateCanvasVM } from '../client/normalize-canvas.ts';
import type { ActionView } from '../client/recruiting/view-model.ts';
import {
  blockerTextOf,
  buildDecisionRecordBody,
  buildInterviewScheduleBody,
  buildScreeningDecisionBody,
  buildStageAdvanceBody,
  decisionRecordBlockers,
  describeActionError,
  fetchDecisionFacts,
  newIdempotencyKey,
  postActionSeam,
  postCandidateConstraint,
  postDecisionRecordFacade,
  screeningDecisionBlockers,
  type ActionOutcome,
  type CanvasActionError,
} from '../client/canvas/canvas-actions.ts';
import {
  fetchAppJson,
  type AgentUiModalKind,
  type AgentUiWriteProposal,
} from './api.ts';

export interface InlineConfirmCardProps {
  readonly sid: string;
  readonly proposal: AgentUiWriteProposal;
  readonly onCommitted: () => void;
  readonly onFallbackModal?: (modal: AgentUiModalKind, applicationId: string) => void;
}

type CardState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'confirmed'; readonly message: string; readonly timeText: string }
  | { readonly kind: 'cancelled' };

function formatNowHm(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatOutcomeError(outcome: ActionOutcome): string {
  const code = `${outcome.error?.code ?? ''} ${outcome.error?.reasonCode ?? ''}`.toUpperCase();
  if (
    outcome.status === 409 &&
    (code.includes('VERSION') || code.includes('CONFLICT') || code.includes('STALE'))
  ) {
    return '这条记录刚被更新，请刷新后重试。';
  }
  if (
    outcome.status === 409 &&
    (code.includes('DUPLICATE') || code.includes('ALREADY') || code.includes('DECISION_EXISTS'))
  ) {
    return '已处理过，不会重复写入。';
  }
  if (code.includes('SCORECARD_MISSING')) {
    return '还有面试官尚未提交面评，暂时不能提交终审决策。';
  }
  return (
    outcome.error?.message ||
    describeActionError(outcome.error?.code ?? '', outcome.error?.reasonCode ?? '') ||
    '操作未能完成，请稍后重试。'
  );
}

function requireLiveAction(
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

function computeDurationMinutes(startIso: string, endIso: string): number {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 60;
  const mins = Math.round((e - s) / 60000);
  return Math.max(15, Math.min(240, mins));
}

export function InlineConfirmCard({
  sid,
  proposal,
  onCommitted,
  onFallbackModal,
}: InlineConfirmCardProps) {
  const [state, setState] = useState<CardState>({ kind: 'pending' });
  const [errorText, setErrorText] = useState<string | null>(null);
  const [blockerText, setBlockerText] = useState<string | null>(null);
  const [checkingFacts, setCheckingFacts] = useState<boolean>(
    proposal.intent === 'decision_record',
  );

  // For final decision proposals, pre-check live application detail (missing scorecards / action availability)
  // alongside decision facts so missing scorecards block honestly and disable submit before click.
  useEffect(() => {
    if (proposal.intent !== 'decision_record') return;
    let active = true;
    setCheckingFacts(true);
    Promise.all([
      fetchAppJson(
        `/recruitment/api/recruiting/applications/${encodeURIComponent(proposal.application_id)}`,
        sid,
      ),
      fetchDecisionFacts(proposal.application_id, sid),
    ])
      .then(([rawDetail, res]) => {
        if (!active) return;
        const vm = normalizeApplicationDetail(rawDetail);
        if (vm.missingScorecardNames.length > 0) {
          setBlockerText(
            `还缺 ${vm.missingScorecardNames.join('、')} 的面评，暂时不能提交终审决策。`,
          );
          return;
        }
        const decisionAction = vm.actions.decision_record;
        if (decisionAction && !decisionAction.available) {
          setBlockerText(
            decisionAction.reasonText ||
              decisionAction.pendingText ||
              '当前阶段暂不可提交终审决策。',
          );
          return;
        }
        if (res.probe !== 'READY' || !res.facts) {
          setBlockerText('决策汇总尚未就绪，暂时无法提交终审决策。');
          return;
        }
        const blockers = decisionRecordBlockers(res.facts);
        if (blockers.length > 0) {
          setBlockerText(blockers.map((b) => blockerTextOf(b)).join('；'));
        } else {
          setBlockerText(null);
        }
      })
      .catch(() => {
        if (!active) return;
        setBlockerText('暂时无法校验面评完整状态，请使用弹窗确认。');
      })
      .finally(() => {
        if (active) setCheckingFacts(false);
      });
    return () => {
      active = false;
    };
  }, [proposal.application_id, proposal.intent, sid]);

  const isDanger = useMemo(() => {
    if (proposal.tone === 'danger') return true;
    if (proposal.intent === 'screening_decide' && proposal.payload.decision === 'REJECT') return true;
    if (proposal.intent === 'decision_record' && proposal.payload.final_outcome === 'REJECT') return true;
    return false;
  }, [proposal]);

  const statusText =
    state.kind === 'confirmed'
      ? '已执行'
      : state.kind === 'submitting'
        ? '提交中'
        : blockerText
          ? '无法提交'
          : '待确认';

  if (state.kind === 'cancelled') {
    return (
      <div className="msg-confirm-cancelled" data-testid="app-chat-confirm-card">
        已取消本次建议（{proposal.title}）
      </div>
    );
  }

  const handleConfirm = async () => {
    if (state.kind !== 'pending' || blockerText || checkingFacts) return;
    setErrorText(null);
    setState({ kind: 'submitting' });

    try {
      const appId = proposal.application_id;
      const p = proposal.payload;

      if (proposal.intent === 'candidate_constraint') {
        const text = (p.constraint_text ?? '').trim();
        const kind = p.constraint_kind === 'HANDOFF' ? 'HANDOFF' : 'PIN';
        if (!text) {
          setErrorText('缺少提醒内容，请在右侧弹窗补充后提交。');
          setState({ kind: 'pending' });
          return;
        }
        await postCandidateConstraint({
          action: kind,
          applicationId: appId,
          text,
          source: 'CHAT',
          confirmationText: proposal.title,
        });
        setState({
          kind: 'confirmed',
          message: kind === 'HANDOFF' ? '已记录下一轮交接提醒' : '已添加置顶约束',
          timeText: formatNowHm(),
        });
        onCommitted();
        return;
      }

      const rawDetail = await fetchAppJson(
        `/recruitment/api/recruiting/applications/${encodeURIComponent(appId)}`,
        sid,
      );
      const vm = normalizeApplicationDetail(rawDetail);

      if (proposal.intent === 'screening_decide') {
        const actCheck = requireLiveAction(vm, 'screening_decide', '初筛结论');
        if (!actCheck.ok) {
          setErrorText(actCheck.message);
          setState({ kind: 'pending' });
          return;
        }
        const factsRes = await fetchDecisionFacts(appId, sid);
        if (factsRes.probe !== 'READY' || !factsRes.facts) {
          setErrorText('初筛评估信息尚未就绪，请稍后重试或在弹窗中操作。');
          setState({ kind: 'pending' });
          return;
        }
        const blockers = screeningDecisionBlockers(factsRes.facts, true);
        if (blockers.length > 0) {
          setErrorText(blockers.map((b) => blockerTextOf(b)).join('；'));
          setState({ kind: 'pending' });
          return;
        }
        const result = p.decision === 'REJECT' ? 'REJECT' : 'ADVANCE';
        const built = buildScreeningDecisionBody({
          facts: factsRes.facts,
          applicationId: appId,
          result,
          reason: (p.rationale ?? '').trim() || '依据岗位标准完成初筛评估',
        });
        if (!built.ok) {
          setErrorText(built.reasonText);
          setState({ kind: 'pending' });
          return;
        }
        const outcome = await postActionSeam(actCheck.action, built.body, sid);
        if (!outcome.accepted) {
          setErrorText(formatOutcomeError(outcome));
          setState({ kind: 'pending' });
          return;
        }
        setState({
          kind: 'confirmed',
          message: result === 'REJECT' ? '已记录初筛不通过并结束申请' : '已通过初筛并进入面试阶段',
          timeText: formatNowHm(),
        });
        onCommitted();
        return;
      }

      if (proposal.intent === 'stage_advance') {
        const actCheck = requireLiveAction(vm, 'stage_advance', '推进阶段');
        if (!actCheck.ok) {
          setErrorText(actCheck.message);
          setState({ kind: 'pending' });
          return;
        }
        const built = buildStageAdvanceBody({ applicationId: appId });
        if (!built.ok) {
          setErrorText(built.reasonText);
          setState({ kind: 'pending' });
          return;
        }
        const outcome = await postActionSeam(actCheck.action, built.body, sid);
        if (!outcome.accepted) {
          setErrorText(formatOutcomeError(outcome));
          setState({ kind: 'pending' });
          return;
        }
        setState({
          kind: 'confirmed',
          message: '已推进至下一阶段',
          timeText: formatNowHm(),
        });
        onCommitted();
        return;
      }

      if (proposal.intent === 'interview_schedule') {
        const actCheck = requireLiveAction(vm, 'interview_schedule', '安排面试');
        if (!actCheck.ok) {
          setErrorText(actCheck.message);
          setState({ kind: 'pending' });
          return;
        }
        const startAt = (p.scheduled_start ?? '').trim();
        const endAt = (p.scheduled_end ?? '').trim();
        const interviewerId = (p.interviewer_id ?? '').trim();
        if (!startAt || !interviewerId) {
          setErrorText('面试官或时间信息不完整，请点击「在弹窗微调」继续。');
          setState({ kind: 'pending' });
          return;
        }
        const built = buildInterviewScheduleBody({
          applicationId: appId,
          roundNo: typeof p.round_number === 'number' && p.round_number >= 1 ? p.round_number : 1,
          scheduledStartAt: startAt,
          durationMinutes: computeDurationMinutes(startAt, endAt),
          interviewers: [{ actorId: interviewerId, requiredScorecard: true }],
          idempotencyKey: newIdempotencyKey(),
          timezone: (p.timezone ?? '').trim() || 'Asia/Shanghai',
        });
        if (!built.ok) {
          setErrorText(built.reasonText);
          setState({ kind: 'pending' });
          return;
        }
        const outcome = await postActionSeam(actCheck.action, built.body, sid);
        if (!outcome.accepted) {
          setErrorText(formatOutcomeError(outcome));
          setState({ kind: 'pending' });
          return;
        }
        setState({
          kind: 'confirmed',
          message: '已安排面试并同步落库',
          timeText: formatNowHm(),
        });
        onCommitted();
        return;
      }

      if (proposal.intent === 'decision_record') {
        if (vm.missingScorecardNames.length > 0) {
          const msg = `还缺 ${vm.missingScorecardNames.join('、')} 的面评，暂时不能提交终审决策。`;
          setBlockerText(msg);
          setState({ kind: 'pending' });
          return;
        }
        const decisionAction = vm.actions.decision_record;
        if (decisionAction && !decisionAction.available) {
          setErrorText(
            decisionAction.reasonText || decisionAction.pendingText || '当前阶段暂不可提交正式决策',
          );
          setState({ kind: 'pending' });
          return;
        }
        const factsRes = await fetchDecisionFacts(appId, sid);
        if (factsRes.probe !== 'READY' || !factsRes.facts) {
          setErrorText('决策汇总尚未生成，暂时不能提交正式决策。');
          setState({ kind: 'pending' });
          return;
        }
        const blockers = decisionRecordBlockers(factsRes.facts);
        if (blockers.length > 0) {
          const msg = blockers.map((b) => blockerTextOf(b)).join('；');
          setBlockerText(msg);
          setState({ kind: 'pending' });
          return;
        }
        const result =
          p.final_outcome === 'REJECT'
            ? 'REJECT'
            : p.final_outcome === 'HOLD'
              ? 'HOLD'
              : 'ADVANCE';
        const built = buildDecisionRecordBody({
          facts: factsRes.facts,
          applicationId: appId,
          scope: 'FINAL',
          result,
          reason: (p.rationale ?? '').trim() || '综合各轮评估完成正式决策',
        });
        if (!built.ok) {
          setErrorText(built.reasonText);
          setState({ kind: 'pending' });
          return;
        }
        const outcome = await postDecisionRecordFacade(built.body, sid);
        if (!outcome.accepted) {
          setErrorText(formatOutcomeError(outcome));
          setState({ kind: 'pending' });
          return;
        }
        setState({
          kind: 'confirmed',
          message: '已记录正式决策并同步落库',
          timeText: formatNowHm(),
        });
        onCommitted();
      }
    } catch (err) {
      const caErr = err as Partial<CanvasActionError> | undefined;
      const msg =
        caErr?.userMessage ||
        (err instanceof Error ? err.message : '操作未能完成，请稍后重试。');
      setErrorText(msg);
      setState({ kind: 'pending' });
    }
  };

  return (
    <div
      className="msg-confirm-card"
      data-testid="app-chat-confirm-card"
      data-intent={proposal.intent}
    >
      <div className="msg-confirm-head">
        <span className="msg-confirm-title">{proposal.title}</span>
        <span
          className={`msg-confirm-status${state.kind === 'confirmed' ? ' is-done' : blockerText ? ' is-blocked' : ''}`}
        >
          {statusText}
        </span>
      </div>

      <div className="msg-confirm-rows">
        {proposal.summary.map((row, idx) => (
          <div key={`${row.label}-${idx}`} className="msg-confirm-row">
            <span className="msg-confirm-key">{row.label}</span>
            <span className="msg-confirm-val num">{row.value}</span>
          </div>
        ))}
      </div>

      {blockerText ? <div className="msg-confirm-error">{blockerText}</div> : null}
      {errorText ? <div className="msg-confirm-error">{errorText}</div> : null}

      <div className="msg-confirm-foot">
        {state.kind === 'confirmed' ? (
          <div className="msg-confirm-done">
            <span>✓ {state.message}</span>
            <span className="num">{state.timeText}</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={`msg-confirm-submit${isDanger ? ' is-danger' : ''}`}
              data-testid="app-chat-confirm-submit"
              disabled={state.kind === 'submitting' || checkingFacts || Boolean(blockerText)}
              onClick={() => void handleConfirm()}
            >
              {state.kind === 'submitting'
                ? '提交中…'
                : checkingFacts
                  ? '校验中…'
                  : '确认执行'}
            </button>
            <button
              type="button"
              className="msg-confirm-cancel"
              data-testid="app-chat-confirm-cancel"
              disabled={state.kind === 'submitting'}
              onClick={() => setState({ kind: 'cancelled' })}
            >
              取消
            </button>
            {proposal.fallback_modal && onFallbackModal ? (
              <button
                type="button"
                className="msg-confirm-fallback"
                data-testid="app-chat-confirm-fallback"
                disabled={state.kind === 'submitting'}
                onClick={() => onFallbackModal(proposal.fallback_modal!, proposal.application_id)}
              >
                在弹窗微调
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
