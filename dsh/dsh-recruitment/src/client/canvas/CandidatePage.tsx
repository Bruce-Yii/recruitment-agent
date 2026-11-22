import React, { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeApplicationDetail, type CandidateCanvasVM } from '../normalize-canvas.ts';
import {
  getCachedCanvasData,
  getSavedCanvasScroll,
  invalidateCachedCanvasData,
  prefetchCanvasPath,
  saveCanvasScroll,
  setCachedCanvasData,
} from './canvas-ux.ts';
import {
  CanvasEmptyState,
  CanvasErrorState,
  FactLabelsBar,
  SequentialRoundRail,
  StatusLabel,
} from './bits/index.ts';
import type {
  ActiveUploadTask,
  CanvasFocusRequest,
  CanvasModalRequest,
  UndoToastPayload,
} from './CanvasRoute.tsx';
import {
  describeActionError,
  getCanvasSessionId,
  postApplicationStar,
  postCriterionOverride,
  postRebindMinute,
  postScreeningEvaluate,
  uploadResumeRaw,
  type CanvasActionError,
  type CriterionHumanState,
} from './canvas-actions.ts';
import {
  CandidateActionModal,
  type CandidateModalKind,
  type CandidateModalSuccess,
} from './CandidateActionModal.tsx';

export type CanvasFetcher = (path: string) => Promise<unknown>;

export interface CandidatePageProps {
  readonly sessionId?: string;
  applicationId: string;
  candidateQueue?: readonly string[];
  focusRequest?: CanvasFocusRequest | null;
  onFocusConsumed?: () => void;
  openModalRequest?: CanvasModalRequest | null;
  onModalRequestConsumed?: () => void;
  onJobResolved?: (jobId: string) => void;
  onSelectApplication?: (applicationId: string) => void;
  onBack?: () => void;
  onOpenJob?: (jobId: string) => void;
  onUploadStarted?: (task: ActiveUploadTask) => void;
  onActionCompleted?: (notice: UndoToastPayload) => void;
  refreshNonce?: number;
  fetcher: CanvasFetcher;
}

type DocTab = 'resume' | 'transcript' | 'original';

interface CandidatePinItem {
  readonly kind: string;
  readonly text: string;
  readonly fromPreviousRound: boolean;
}

function extractCandidatePins(raw: unknown): CandidatePinItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const appObj =
    obj.application && typeof obj.application === 'object'
      ? (obj.application as Record<string, unknown>)
      : obj;
  const list = Array.isArray(obj.constraints)
    ? obj.constraints
    : Array.isArray(appObj.constraints)
      ? appObj.constraints
      : [];
  const out: CandidatePinItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!text) continue;
    const kind = typeof rec.kind === 'string' ? rec.kind.trim().toUpperCase() : 'PIN';
    const fromPreviousRound = rec.from_previous_round === true || kind === 'HANDOFF';
    out.push({ kind, text, fromPreviousRound });
  }
  return out;
}

function buildDecisionMemoText(vm: CandidateCanvasVM, pins: readonly CandidatePinItem[]): string {
  const lines: string[] = [
    `【${vm.jobTitle} · ${vm.candidateName}】${vm.stageLabel}（${vm.lifecycleLabel}）`,
    `核心提炼：${vm.summaryText}`,
  ];
  if (pins.length > 0) {
    lines.push(
      `置顶提醒：${pins.map((p) => (p.fromPreviousRound ? `[交接] ${p.text}` : p.text)).join('；')}`,
    );
  }
  if (vm.criteria.length > 0) {
    lines.push(
      `岗位标准（${vm.rubricVersionLabel}）：${vm.criteria.map((c) => `${c.label}=${c.statusText}`).join('；')}`,
    );
  }
  if (vm.rounds.length > 0) {
    lines.push(
      `面试进展：${vm.rounds.map((r) => `${r.roundLabel}(${r.statusText}，${r.scorecardsSummary})`).join(' / ')}`,
    );
  }
  return lines.join('\n');
}

export function CandidatePage({
  sessionId,
  applicationId,
  candidateQueue,
  focusRequest,
  onFocusConsumed,
  openModalRequest,
  onModalRequestConsumed,
  onJobResolved,
  onSelectApplication,
  onBack,
  onOpenJob,
  onUploadStarted,
  onActionCompleted,
  refreshNonce = 0,
  fetcher,
}: CandidatePageProps) {
  const detailPath = `/recruitment/api/recruiting/applications/${encodeURIComponent(applicationId)}`;
  const routeKey = `candidate:${applicationId}`;

  const [vm, setVm] = useState<CandidateCanvasVM | null>(() => {
    const cached = getCachedCanvasData(detailPath);
    return cached !== undefined ? normalizeApplicationDetail(cached) : null;
  });
  const [pins, setPins] = useState<CandidatePinItem[]>(() => {
    const cached = getCachedCanvasData(detailPath);
    return cached !== undefined ? extractCandidatePins(cached) : [];
  });
  const [loading, setLoading] = useState(() => getCachedCanvasData(detailPath) === undefined);
  const [syncing, setSyncing] = useState(false);
  const [flashTick, setFlashTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [activeCrit, setActiveCrit] = useState('');
  const [docTab, setDocTab] = useState<DocTab>('resume');
  const [expandedTs, setExpandedTs] = useState<number | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const [modalKind, setModalKind] = useState<CandidateModalKind | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [starredLocal, setStarredLocal] = useState(false);
  const [starPop, setStarPop] = useState(false);
  const [starBusy, setStarBusy] = useState(false);
  const [candUploading, setCandUploading] = useState(false);
  const [evaluatingScreening, setEvaluatingScreening] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<{ key: string; label: string } | null>(null);
  const [overrideState, setOverrideState] = useState<CriterionHumanState>('PRESENT');
  const [overrideNote, setOverrideNote] = useState('');
  const [overrideConfirm, setOverrideConfirm] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const candFileRef = useRef<HTMLInputElement | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);

  const [pendingRebind, setPendingRebind] = useState<CandidateModalSuccess['rebindPrompt'] | null>(null);
  const [rebindConfirmText, setRebindConfirmText] = useState('');
  const [rebindSubmitting, setRebindSubmitting] = useState(false);
  const [focusedSection, setFocusedSection] = useState<string | null>(null);
  const lastFocusNonceRef = useRef<number>(0);
  const lastModalNonceRef = useRef<number>(0);
  const focusRafRef = useRef<number | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (cancelledRef?: { current: boolean }, opts?: { silent?: boolean; flash?: boolean }) => {
      const cached = getCachedCanvasData(detailPath);
      const hasContent = opts?.silent || cached !== undefined;
      if (cached !== undefined && !opts?.silent) {
        const fast = normalizeApplicationDetail(cached);
        setVm(fast);
        setPins(extractCandidatePins(cached));
        setStarredLocal(fast.starred);
        setActiveCrit((prev) => prev || fast.criteria[0]?.key || '');
      }
      if (hasContent) {
        setSyncing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const raw = await fetcher(detailPath);
        if (cancelledRef?.current) return;
        setCachedCanvasData(detailPath, raw);
        const next = normalizeApplicationDetail(raw);
        setVm(next);
        setPins(extractCandidatePins(raw));
        setStarredLocal(next.starred);
        setActiveCrit((prev) => prev || next.criteria[0]?.key || '');
        if (opts?.flash) setFlashTick((n) => n + 1);
      } catch {
        if (cancelledRef?.current) return;
        if (!hasContent) setError('暂时没能读取到这位候选人的档案，请稍后重试。');
      } finally {
        if (!cancelledRef?.current) {
          setLoading(false);
          setSyncing(false);
        }
      }
    },
    [detailPath, fetcher],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    void load(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [load, refreshNonce]);

  // Restore scroll position on candidate open
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el || loading) return;
    el.scrollTop = getSavedCanvasScroll(routeKey);
  }, [routeKey, loading]);

  // Surface current candidate's jobId to parent shell (e.g. ChatPanel context.job_id)
  useEffect(() => {
    if (vm?.jobId) {
      onJobResolved?.(vm.jobId);
    }
  }, [vm?.jobId, onJobResolved]);

  useEffect(() => {
    return () => {
      if (focusRafRef.current !== null) cancelAnimationFrame(focusRafRef.current);
      if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    };
  }, []);

  // Read-only section focus & highlight (driven by Agent ui_action focus_section)
  useEffect(() => {
    if (!focusRequest || loading || !vm) return;
    if (focusRequest.nonce === lastFocusNonceRef.current) return;
    const targetSec =
      focusRequest.section === 'rubric' ? 'criteria' : focusRequest.section;
    if (
      targetSec !== 'summary' &&
      targetSec !== 'criteria' &&
      targetSec !== 'resume' &&
      targetSec !== 'interviews'
    ) {
      return;
    }
    lastFocusNonceRef.current = focusRequest.nonce;
    if (targetSec === 'resume' && docTab !== 'resume') {
      setDocTab('resume');
    }
    setFocusedSection(targetSec);
    if (focusRafRef.current !== null) cancelAnimationFrame(focusRafRef.current);
    if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    focusRafRef.current = requestAnimationFrame(() => {
      focusRafRef.current = null;
      const target = bodyScrollRef.current?.querySelector(`[data-section="${targetSec}"]`);
      if (target && typeof (target as HTMLElement).scrollIntoView === 'function') {
        (target as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null;
      setFocusedSection((cur) => (cur === targetSec ? null : cur));
    }, 1800);
    onFocusConsumed?.();
  }, [focusRequest, loading, vm, docTab, onFocusConsumed]);

  // Controlled modal opening (only after human clicks a suggest_action button in chat)
  useEffect(() => {
    if (!openModalRequest || loading || !vm) return;
    if (openModalRequest.nonce === lastModalNonceRef.current) return;
    lastModalNonceRef.current = openModalRequest.nonce;
    setModalKind(openModalRequest.modal);
    onModalRequestConsumed?.();
  }, [openModalRequest, loading, vm, onModalRequestConsumed]);

  const queueIndex = candidateQueue ? candidateQueue.indexOf(applicationId) : -1;
  const prevAppId = queueIndex > 0 && candidateQueue ? candidateQueue[queueIndex - 1] : undefined;
  const nextAppId =
    queueIndex >= 0 && candidateQueue && queueIndex < candidateQueue.length - 1
      ? candidateQueue[queueIndex + 1]
      : undefined;

  // Auto-prefetch next candidate in queue for instant book-flipping navigation
  useEffect(() => {
    if (!nextAppId) return;
    prefetchCanvasPath(`/recruitment/api/recruiting/applications/${encodeURIComponent(nextAppId)}`, fetcher);
  }, [nextAppId, fetcher]);

  // Keyboard-first shortcuts: Esc back, [ previous candidate, ] next candidate
  useEffect(() => {
    if (modalKind !== null || pendingRebind !== null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape' && onBack) {
        e.preventDefault();
        onBack();
      } else if (e.key === '[' && prevAppId && onSelectApplication) {
        e.preventDefault();
        onSelectApplication(prevAppId);
      } else if (e.key === ']' && nextAppId && onSelectApplication) {
        e.preventDefault();
        onSelectApplication(nextAppId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack, prevAppId, nextAppId, onSelectApplication, modalKind, pendingRebind]);

  const handleCopyDecisionMemo = () => {
    if (!vm) return;
    const text = buildDecisionMemoText(vm, pins);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setActionFeedback({ tone: 'green', text: `已复制 ${vm.candidateName} 的决策纪要` });
        })
        .catch(() => {
          setActionFeedback({ tone: 'green', text: `已生成 ${vm.candidateName} 的决策纪要（当前环境限制剪贴板写入）` });
        });
    } else {
      setActionFeedback({ tone: 'green', text: `已生成 ${vm.candidateName} 的决策纪要` });
    }
  };

  const handleRunScreeningEvaluate = async () => {
    if (!vm || evaluatingScreening) return;
    const activeSessionId = (sessionId ?? '').trim() || getCanvasSessionId();
    setEvaluatingScreening(true);
    setActionFeedback(null);
    try {
      const outcome = await postScreeningEvaluate(vm.applicationId, activeSessionId);
      if (!outcome.accepted) {
        setActionFeedback({
          tone: 'red',
          text:
            outcome.error?.message ||
            describeActionError(outcome.error?.code ?? '', outcome.error?.reasonCode ?? '') ||
            '初筛评估未能完成，请稍后重试。',
        });
        return;
      }
      setActionFeedback({ tone: 'green', text: '已更新初筛评估结果。' });
      invalidateCachedCanvasData(detailPath);
      void load(undefined, { silent: true });
      onActionCompleted?.({ message: '已更新初筛评估结果' });
    } catch (err) {
      setActionFeedback({
        tone: 'red',
        text: err instanceof Error ? err.message : '初筛评估未能完成，请稍后重试。',
      });
    } finally {
      setEvaluatingScreening(false);
    }
  };

  const handleSubmitCriterionOverride = async () => {
    if (!vm || !overrideTarget || overrideBusy) return;
    const confirmText = overrideConfirm.trim();
    if (!confirmText) {
      setActionFeedback({ tone: 'red', text: '请先输入一句确认原话后再提交纠偏。' });
      return;
    }
    setOverrideBusy(true);
    setActionFeedback(null);
    try {
      await postCriterionOverride({
        applicationId: vm.applicationId,
        criterionKey: overrideTarget.key,
        humanState: overrideState,
        note: overrideNote.trim() || undefined,
        confirmationText: confirmText,
      });
      const label = overrideTarget.label;
      setOverrideTarget(null);
      setOverrideNote('');
      setOverrideConfirm('');
      setActionFeedback({ tone: 'green', text: `已记录「${label}」的人工纠偏并同步落库。` });
      invalidateCachedCanvasData(detailPath);
      void load(undefined, { silent: true });
      onActionCompleted?.({ message: `已记录「${label}」的人工纠偏` });
    } catch (err) {
      const caErr = err as Partial<CanvasActionError> | undefined;
      setActionFeedback({
        tone: 'red',
        text: caErr?.userMessage || (err instanceof Error ? err.message : '人工纠偏未能完成，请稍后重试。'),
      });
    } finally {
      setOverrideBusy(false);
    }
  };

  const handleSelectCriterion = (critKey: string) => {
    setActiveCrit(critKey);
    if (docTab !== 'resume') setDocTab('resume');
    requestAnimationFrame(() => {
      const target = bodyScrollRef.current?.querySelector(`[data-crit-match="${critKey}"]`);
      if (target && typeof (target as HTMLElement).scrollIntoView === 'function') {
        (target as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  };

  const handleModalSuccess = async (res: CandidateModalSuccess) => {
    setModalKind(null);
    invalidateCachedCanvasData(detailPath);
    if (vm?.jobId) {
      invalidateCachedCanvasData(`/recruitment/api/recruiting/jobs/${encodeURIComponent(vm.jobId)}`);
    }
    await load(undefined, { silent: true, flash: true });
    setActionFeedback({ tone: 'green', text: res.message });
    onActionCompleted?.({ message: res.message, actionId: res.actionId });
    if (res.rebindPrompt) {
      setPendingRebind(res.rebindPrompt);
      setRebindConfirmText(`确认把 ${vm?.candidateName || '候选人'} 这场面试的录音归属改到新面试官`);
    }
  };

  const handleRebindMinute = async () => {
    if (!pendingRebind || rebindSubmitting) return;
    if (!rebindConfirmText.trim()) {
      setActionFeedback({ tone: 'red', text: '请先填写一句确认原话再修改录音归属。' });
      return;
    }
    setRebindSubmitting(true);
    try {
      const res = await postRebindMinute({
        interviewId: pendingRebind.interviewId,
        fromActorId: pendingRebind.fromActorId,
        toActorId: pendingRebind.toActorId,
        minuteToken: pendingRebind.minuteToken,
        confirmationText: rebindConfirmText.trim(),
        dryRun: false,
      });
      setPendingRebind(null);
      setActionFeedback({ tone: 'green', text: res.message });
    } catch (err) {
      setActionFeedback({
        tone: 'red',
        text: (err as CanvasActionError)?.userMessage || '录音归属修改未能完成。面评不会因此丢，但录音归属仍是旧的。',
      });
    } finally {
      setRebindSubmitting(false);
    }
  };

  if (loading) {
    return (
      <>
        <header className="ros-canvas-head">
          <div className="ros-head-left">
            {onBack ? <button type="button" className="ros-crumb-link" onClick={onBack}>← 返回</button> : null}
            <span className="ros-crumb-cur">候选人档案</span>
          </div>
        </header>
        <div className="ros-canvas-body"><div className="ros-canvas-inner"><div className="ros-skeleton-doc" aria-label="正在读取候选人档案">
          <div className="ros-skel-bar" style={{ width: '36%', height: 24 }} />
          <div className="ros-skel-bar" style={{ width: '58%', height: 13 }} />
          <div className="ros-skel-bar" style={{ width: '100%', height: 64, marginTop: 8 }} />
          <div className="ros-skel-bar" style={{ width: '92%', height: 42 }} />
          <div className="ros-skel-bar" style={{ width: '86%', height: 42 }} />
        </div></div></div>
      </>
    );
  }

  if (error || !vm) {
    return (
      <>
        <header className="ros-canvas-head">
          <div className="ros-head-left">
            {onBack ? <button type="button" className="ros-crumb-link" onClick={onBack}>← 返回</button> : null}
            <span className="ros-crumb-cur">候选人档案</span>
          </div>
        </header>
        <div className="ros-canvas-body"><div className="ros-canvas-inner"><CanvasErrorState message={error || undefined} onRetry={() => void load()} /></div></div>
      </>
    );
  }

  let lineNo = 0;

  return (
    <>
      <header className="ros-canvas-head">
        <div className="ros-head-left">
          <div className="ros-crumb-bar">
            {onBack ? (<><button type="button" className="ros-crumb-link" onClick={onBack}>← 返回</button><span>/</span></>) : null}
            {onOpenJob && vm.jobId ? (
              <button type="button" className="ros-crumb-link" onClick={() => onOpenJob(vm.jobId)}>{vm.jobTitle}</button>
            ) : (
              <span>{vm.jobTitle}</span>
            )}
            <span>/</span><span>{vm.stageLabel}</span><span>/</span>
            <span className="ros-crumb-cur">{vm.candidateName}</span>
          </div>
        </div>
        <div className="ros-head-right" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {syncing ? <span className="ros-sync-pill" data-testid="canvas-sync-pill"><i className="ros-sync-dot" />同步中</span> : null}
          {queueIndex >= 0 && candidateQueue && candidateQueue.length > 1 && onSelectApplication ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '12px', color: 'var(--muted)' }} data-testid="canvas-candidate-pager">
              <button type="button" className="ros-text-link" title="上一位 ([)" disabled={!prevAppId} style={{ opacity: prevAppId ? 1 : 0.35 }} onClick={() => prevAppId && onSelectApplication(prevAppId)}>‹</button>
              <span className="num">{queueIndex + 1} / {candidateQueue.length}</span>
              <button type="button" className="ros-text-link" title="下一位 (])" disabled={!nextAppId} style={{ opacity: nextAppId ? 1 : 0.35 }} onClick={() => nextAppId && onSelectApplication(nextAppId)}>›</button>
            </div>
          ) : null}
          <FactLabelsBar labels={vm.factLabels} />
        </div>
      </header>

      <div className="ros-canvas-body" ref={bodyScrollRef} onScroll={(e) => saveCanvasScroll(routeKey, e.currentTarget.scrollTop)}>
        <div key={applicationId} className="ros-canvas-inner ros-doc ros-canvas-enter">
          {actionFeedback ? (
            <div
              className="ros-risk-note"
              role="status"
              style={{
                borderLeftColor: actionFeedback.tone === 'green' ? 'var(--green)' : 'var(--red)',
                color: actionFeedback.tone === 'green' ? 'var(--green)' : 'var(--red)',
                background: actionFeedback.tone === 'green' ? 'var(--green-soft)' : 'var(--red-soft)',
              }}
            >
              {actionFeedback.text}
            </div>
          ) : null}

          {pendingRebind ? (
            <div className="ros-risk-note" data-testid="rebind-minute-prompt" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontWeight: 600, color: 'var(--ink)' }}>这把录音的归属还挂在旧面试官名下，要改到新人吗？</div>
              <label className="ros-m-field">
                <span>确认原话（外部写入必填）</span>
                <input value={rebindConfirmText} onChange={(e) => setRebindConfirmText(e.target.value)} />
              </label>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="ros-btn" disabled={rebindSubmitting} onClick={() => setPendingRebind(null)}>暂不修改</button>
                <button type="button" className="ros-btn dark" disabled={rebindSubmitting} data-testid="rebind-minute-confirm" onClick={() => void handleRebindMinute()}>
                  {rebindSubmitting ? '处理中…' : '确认改到新人'}
                </button>
              </div>
            </div>
          ) : null}

          <div key={`head-${flashTick}`} className={`ros-doc-head ${flashTick > 0 ? 'ros-paper-flash' : ''}`}>
            <div>
              <div className="ros-doc-name">{vm.candidateName}</div>
              <div className="ros-doc-meta">
                {vm.jobTitle}（{vm.jobCode}）· 档案号 <span className="num">{vm.shortRef}</span> · 标准 {vm.rubricVersionLabel}
              </div>
              {pins.length > 0 ? (
                <div className="ros-pin-row" data-testid="canvas-pin-row">
                  {pins.map((pin, idx) => (
                    <span
                      key={`${pin.kind}-${idx}`}
                      className={`ros-pin-tag ${pin.fromPreviousRound ? 'neutral' : ''}`}
                    >
                      {pin.fromPreviousRound ? `交接：${pin.text}` : pin.text}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  data-testid="canvas-action-star"
                  className={`ros-star-btn ${starPop ? 'pop' : ''}`}
                  disabled={starBusy}
                  title={starredLocal ? '取消星标主推' : '设为星标主推'}
                  style={{ fontSize: '16px', color: starredLocal ? 'var(--amber)' : 'var(--soft)' }}
                  onClick={() => {
                    if (starBusy) return;
                    const prev = starredLocal;
                    const nextVal = !prev;
                    setStarredLocal(nextVal);
                    setStarPop(true);
                    setTimeout(() => setStarPop(false), 220);
                    setStarBusy(true);
                    void postApplicationStar({ applicationId: vm.applicationId, starred: nextVal })
                      .then((res) => {
                        setStarredLocal(Boolean(res.starred));
                        invalidateCachedCanvasData(detailPath);
                        if (vm.jobId) invalidateCachedCanvasData(`/recruitment/api/recruiting/jobs/${encodeURIComponent(vm.jobId)}`);
                        setActionFeedback({ tone: 'green', text: res.starred ? '已标记为主推候选人' : '已取消星标标记' });
                      })
                      .catch((err) => {
                        setStarredLocal(prev);
                        setActionFeedback({ tone: 'red', text: (err as CanvasActionError)?.userMessage || '星标更新失败，已恢复原状态' });
                      })
                      .finally(() => setStarBusy(false));
                  }}
                >
                  {starredLocal ? '★' : '☆'}
                </button>
                <StatusLabel text={vm.stageLabel} tone={vm.isArchived ? '' : 'iris'} />
              </div>
              <div className="ros-doc-head-sub">
                <span className="ros-sec-meta">{vm.lifecycleLabel}</span>
                <span className="ros-sec-meta">·</span>
                <button
                  type="button"
                  className="ros-text-link ros-memo-btn"
                  data-testid="canvas-action-copy-memo"
                  onClick={handleCopyDecisionMemo}
                >
                  复制决策纪要
                </button>
              </div>
            </div>
          </div>

          {vm.stageBlockedReason ? <div className="ros-risk-note">{vm.stageBlockedReason}</div> : null}

          <div
            className={`ros-doc-block ${focusedSection === 'summary' ? 'ros-section-focus' : ''}`}
            data-section="summary"
          >
            <div className="ros-sec-meta">当前状态与提炼</div>
            <div style={{ fontSize: '14.5px', lineHeight: 1.78, color: 'var(--ink)' }}>{vm.summaryText}</div>
          </div>

          {vm.autoScreening ? (
            <div className="ros-doc-block" data-section="auto-screening" data-testid="canvas-auto-screening">
              <div className="ros-sec-meta" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span>自动初筛建议（上传简历后自动生成）</span>
                <StatusLabel text={vm.autoScreening.verdictLabel} tone={vm.autoScreening.verdictTone} />
              </div>
              <div className="ros-risk-note" data-testid="canvas-auto-screening-note">
                <div style={{ fontWeight: 600 }}>{vm.autoScreening.verdictSummary || '只读评估已生成建议。'}</div>
                <div style={{ marginTop: 6, fontSize: '12.5px', color: 'var(--muted)' }}>
                  {vm.autoScreening.advisoryNote}
                </div>
              </div>
              {vm.autoScreening.reasons.length > 0 ? (
                <div>
                  {vm.autoScreening.reasons.map((reason, idx) => (
                    <div key={`${reason.code}-${idx}`} className="ros-clean-row static" style={{ alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 500 }}>
                          {reason.criterionKey || reason.code || '评估项'}
                          {reason.triState ? <span className="ros-sec-meta" style={{ marginLeft: 8 }}>三态：{reason.triState}</span> : null}
                          {reason.outcome ? <span className="ros-sec-meta" style={{ marginLeft: 8 }}>{reason.outcome}</span> : null}
                        </div>
                        <div style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: 2 }}>{reason.message}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            className={`ros-doc-block ${focusedSection === 'criteria' ? 'ros-section-focus' : ''}`}
            data-section="criteria"
          >
            <div
              className="ros-sec-meta"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
            >
              <span>岗位标准对照 · {vm.rubricVersionLabel}（点击联动原文）</span>
              <button
                type="button"
                className="ros-text-link"
                data-testid="canvas-action-screening-evaluate"
                disabled={evaluatingScreening}
                onClick={() => void handleRunScreeningEvaluate()}
              >
                {evaluatingScreening ? '评估中…' : vm.criteria.length > 0 ? '重新评估' : '发起初筛评估'}
              </button>
            </div>
            {vm.criteria.length > 0 ? (
              <div>
                {vm.criteria.map((cr, idx) => (
                  <div key={cr.key} className={`ros-crit-item ${cr.key === activeCrit ? 'active' : ''}`} onClick={() => handleSelectCriterion(cr.key)} role="button" tabIndex={0}>
                    <span style={{ fontSize: '13.5px', fontWeight: 500 }}>
                      <span className="num" style={{ color: 'var(--soft)', marginRight: 8 }}>0{idx + 1}</span>
                      {cr.label}
                      <span className="ros-sec-meta" style={{ marginLeft: 8 }}>{cr.kindLabel}{cr.weightText ? ` · ${cr.weightText}` : ''}</span>
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
                      <StatusLabel text={cr.statusText} tone={cr.level} />
                      <button
                        type="button"
                        className="ros-text-link"
                        data-testid={`canvas-criterion-override-${cr.key}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOverrideTarget({ key: cr.key, label: cr.label });
                          setOverrideState('PRESENT');
                          setOverrideNote('');
                          setOverrideConfirm(`确认将「${cr.label}」人工核定为有对应`);
                        }}
                      >
                        纠偏
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : <CanvasEmptyState title="暂无岗位标准维度" />}
          </div>

          <div
            className={`ros-doc-block ${focusedSection === 'interviews' ? 'ros-section-focus' : ''}`}
            data-section="interviews"
          >
            <div className="ros-sec-meta">逐轮面试进展（不求平均分）</div>
            {vm.rounds.length > 0 ? (
              <>
                <SequentialRoundRail rounds={vm.rounds} />
                <div className="ros-clean-list">
                  {vm.rounds.map((rd) => (
                    <div key={rd.id} className="ros-clean-row static">
                      <div>
                        <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                          {rd.roundLabel}<span className="ros-sec-meta num" style={{ marginLeft: 8 }}>{rd.scheduleText}</span>
                        </div>
                        <div style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: 2 }}>
                          {rd.detailText} · {rd.scorecardsSummary} · {rd.transcriptStateLabel}
                          {rd.overdueCount > 0 ? ` · ${rd.overdueCount} 份面评已超时` : ''}
                        </div>
                      </div>
                      <StatusLabel text={rd.statusText} tone={rd.statusTone === 'done' ? 'green' : rd.statusTone === 'caution' ? 'amber' : 'iris'} />
                    </div>
                  ))}
                </div>
              </>
            ) : <CanvasEmptyState title="尚未安排面试" description="当前还没有进入面试轮次。" />}
          </div>

          <div
            className={`ros-doc-block ${focusedSection === 'resume' ? 'ros-section-focus' : ''}`}
            data-section="resume"
          >
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className={`ros-text-link ${docTab === 'resume' ? 'active' : ''}`} onClick={() => setDocTab('resume')}>简历原文</button>
              <button type="button" className={`ros-text-link ${docTab === 'transcript' ? 'active' : ''}`} onClick={() => setDocTab('transcript')}>飞书妙记</button>
              <button type="button" className={`ros-text-link ${docTab === 'original' ? 'active' : ''}`} onClick={() => setDocTab('original')}>原件预览</button>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 12 }}>
                <input
                  ref={candFileRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.rtf,.txt"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file || candUploading) return;
                    setCandUploading(true);
                    void uploadResumeRaw(file, vm.jobId)
                      .then((started) => onUploadStarted?.(started))
                      .catch((err) => setActionFeedback({ tone: 'red', text: (err as CanvasActionError)?.userMessage || '上传未能提交' }))
                      .finally(() => setCandUploading(false));
                  }}
                />
                <button type="button" className="ros-text-link" disabled={candUploading} data-testid="canvas-action-candidate-upload" onClick={() => candFileRef.current?.click()}>
                  {candUploading ? '上传中…' : '上传简历'}
                </button>
                <button type="button" className="ros-text-link" data-testid="canvas-action-transcript-import" onClick={() => setModalKind('transcript_import')}>
                  导入转写
                </button>
              </span>
            </div>

            {docTab === 'resume' ? (
              vm.resumeSections.length > 0 ? (
                <div>
                  {vm.resumeSections.map((sec) => (
                    <div key={sec.title}>
                      <div className="ros-resume-group">{sec.title}</div>
                      {sec.items.map((it) => {
                        lineNo += 1;
                        return (
                          <div key={it.id} data-crit-match={it.matchKey} className={`ros-doc-line ${it.matchKey === activeCrit ? 'active' : ''}`} onClick={() => setActiveCrit(it.matchKey)}>
                            <span className="ros-doc-no num">{lineNo < 10 ? `0${lineNo}` : String(lineNo)}</span>
                            <div>
                              {it.heading || it.period || it.pageLabel ? (
                                <div className="ros-exp-meta">
                                  <span className="ros-exp-co">{it.heading || ''}</span>
                                  <span className="ros-exp-time num">{it.period || it.pageLabel || ''}</span>
                                </div>
                              ) : null}
                              <div>{it.body}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ) : <CanvasEmptyState title="还没有简历原件" description="当前申请尚未上传或解析出简历内容。" />
            ) : docTab === 'transcript' ? (
              vm.hasTranscript ? (
                <div>
                  {vm.transcriptItems.map((tr, idx) => (
                    <div key={tr.id} className={`ros-doc-line ${tr.matchKey === activeCrit ? 'active' : ''}`} onClick={() => setExpandedTs(expandedTs === idx ? null : idx)}>
                      <span className="ros-doc-no num">0{idx + 1}</span>
                      <div>
                        <div>{tr.timestamp ? <span className="ros-ts-badge num">{tr.timestamp}</span> : null}{tr.summary}</div>
                        {tr.context && expandedTs === idx ? <div className="ros-jd-box" style={{ marginTop: 8, padding: '10px 12px' }}>{tr.context}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : <CanvasEmptyState title="还没有转录" description="面试完成后将自动同步飞书妙记录音转写。" />
            ) : vm.hasResumeMaterial && vm.materialContentUrl ? (
              <div className="ros-jd-box">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span>{vm.materialFileName || '简历原件'}</span>
                  <a href={vm.materialContentUrl} target="_blank" rel="noreferrer" className="ros-text-link active">在新标签页查看原件 ↗</a>
                </div>
              </div>
            ) : <CanvasEmptyState title="还没有简历原件" description="当前申请尚未关联可预览的二进制原件。" />}
          </div>

          {vm.screeningBasis.length > 0 ? (
            <div className="ros-doc-block">
              <div className="ros-sec-meta">初筛依据</div>
              <div className="ros-clean-list">
                {vm.screeningBasis.map((b, idx) => (
                  <div key={`${b.label}-${idx}`} className="ros-clean-row static">
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{b.label}</span>
                    <span style={{ fontSize: '12.5px', color: 'var(--muted)' }}>{b.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {vm.unavailableActions.length > 0 ? (
            <div className="ros-risk-note">
              {vm.unavailableActions.map((act) => (
                <div key={act.key}>「{act.label}」暂不可执行：{act.reason || '当前阶段或条件尚未满足'}</div>
              ))}
            </div>
          ) : null}

          <div>
            <div className="ros-auto-toggle" onClick={() => setTimelineOpen((v) => !v)} role="button" tabIndex={0}>
              <span>全链路动态留痕（{vm.timeline.length}）</span>
              <span>{timelineOpen ? '收起 ▴' : '展开 ▾'}</span>
            </div>
            {timelineOpen ? (
              vm.timeline.length > 0 ? (
                <div className="ros-clean-list">
                  {vm.timeline.map((t) => (
                    <div key={t.id} className="ros-clean-row static">
                      <span style={{ fontSize: '13px' }}>{t.label}</span>
                      <span className="ros-sec-meta num">{t.timeText}</span>
                    </div>
                  ))}
                </div>
              ) : <CanvasEmptyState title="暂无动态留痕" />
            ) : null}
          </div>

          <div className="ros-doc-foot">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <button type="button" className="ros-text-link" data-testid="canvas-action-pin" onClick={() => setModalKind('pin')}>置顶约束</button>
              <button type="button" className="ros-text-link" data-testid="canvas-action-handoff" onClick={() => setModalKind('handoff')}>下一轮交接</button>
              <button type="button" className="ros-text-link" data-testid="canvas-action-schedule" onClick={() => setModalKind('schedule')}>约面 / 改期换人</button>
              <button type="button" className="ros-text-link" data-testid="canvas-action-transfer" onClick={() => setModalKind('transfer')}>跨岗调剂</button>
              <button type="button" className="ros-text-link" data-testid="canvas-action-stage-advance" onClick={() => setModalKind('stage_advance')}>推进阶段 / 跳轮</button>
              <button type="button" className="ros-text-link" data-testid="canvas-action-no-show" onClick={() => setModalKind('no_show')}>标记未出席</button>
              <button type="button" className="ros-text-link" data-testid="canvas-action-email" onClick={() => setModalKind('email')}>发邮件</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" className="ros-btn" data-testid="canvas-action-screening" onClick={() => setModalKind('screening')}>初筛结论</button>
              <button type="button" className="ros-btn dark" data-testid="canvas-action-decision" onClick={() => setModalKind('decision')}>正式决策</button>
            </div>
          </div>
        </div>
      </div>

      {overrideTarget ? (
        <div
          className="ros-modal-bg"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !overrideBusy) setOverrideTarget(null);
          }}
        >
          <div className="ros-modal">
            <div style={{ fontSize: '17px', fontWeight: 650 }}>
              人工纠偏 · {overrideTarget.label}
            </div>
            <div className="ros-jd-box" style={{ padding: '12px 14px' }}>
              人工纠偏将以追加记录方式留痕，不覆盖 AI 原始判断，也不修改岗位标准定义。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {(
                [
                  { id: 'PRESENT', label: '有对应' },
                  { id: 'ABSENT', label: '没有对应' },
                  { id: 'UNREADABLE', label: '读不出来' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ros-slot-pill ${overrideState === opt.id ? 'active' : ''}`}
                  data-testid={`canvas-override-state-${opt.id.toLowerCase()}`}
                  disabled={overrideBusy}
                  onClick={() => {
                    setOverrideState(opt.id);
                    setOverrideConfirm(`确认将「${overrideTarget.label}」人工核定为${opt.label}`);
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <label className="ros-m-field">
              <span>补充说明（选填）</span>
              <input
                data-testid="canvas-override-note"
                value={overrideNote}
                disabled={overrideBusy}
                onChange={(e) => setOverrideNote(e.target.value)}
                placeholder="例如：简历第 2 页项目经历可印证该项能力"
              />
            </label>
            <label className="ros-m-field">
              <span>确认原话（留痕必填）</span>
              <input
                data-testid="canvas-override-confirm-input"
                value={overrideConfirm}
                disabled={overrideBusy}
                onChange={(e) => setOverrideConfirm(e.target.value)}
                placeholder="输入一句确认原话"
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="ros-btn"
                disabled={overrideBusy}
                onClick={() => setOverrideTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="ros-btn dark"
                data-testid="canvas-override-submit"
                disabled={overrideBusy || !overrideConfirm.trim()}
                onClick={() => void handleSubmitCriterionOverride()}
              >
                {overrideBusy ? '提交中…' : '确认纠偏'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modalKind ? (
        <CandidateActionModal
          kind={modalKind}
          vm={vm}
          sessionId={sessionId}
          onClose={() => setModalKind(null)}
          onSuccess={(res) => void handleModalSuccess(res)}
        />
      ) : null}
    </>
  );
}
