import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeApplicationDetail,
  normalizeJobDetail,
  type CandidateCanvasVM,
  type JobApplicationRowVM,
  type JobCanvasVM,
} from '../normalize-canvas.ts';
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
  CanvasLoadingState,
  FactLabelsBar,
  StageTrack,
  StatusLabel,
} from './bits/index.ts';
import type { CanvasFetcher } from './CandidatePage.tsx';
import type { ActiveUploadTask, CanvasFocusRequest, UndoToastPayload } from './CanvasRoute.tsx';
// Issue #60：同源 CSV 下载复用统一客户端契约。
import { downloadApplicationsCsv } from '../external-sync.ts';
import {
  buildJobCloseBody,
  buildJobCreateBody,
  buildRubricApproveBody,
  describeActionError,
  getCanvasSessionId,
  postActionSeam,
  postBatchReject,
  postJobClose,
  postJobCreate,
  uploadResumeRaw,
  type BatchRejectItemResult,
  type CanvasActionError,
} from './canvas-actions.ts';

export interface JobPageProps {
  readonly sessionId?: string;
  jobId: string;
  focusRequest?: CanvasFocusRequest | null;
  onFocusConsumed?: () => void;
  onBack?: () => void;
  onSelectApplication?: (applicationId: string, queue?: string[]) => void;
  onSelectJob?: (jobId: string) => void;
  onUploadStarted?: (task: ActiveUploadTask) => void;
  onActionCompleted?: (notice: UndoToastPayload) => void;
  refreshNonce?: number;
  fetcher: CanvasFetcher;
}

type JobTab = 'pipeline' | 'rubric';
type StageFilter = '全部' | JobApplicationRowVM['filterBucket'];

const STAGE_FILTERS: StageFilter[] = ['全部', '接入', '初筛', '面试中', '终审与 Offer', '已结束'];

export function JobPage({
  sessionId,
  jobId,
  focusRequest,
  onFocusConsumed,
  onBack,
  onSelectApplication,
  onSelectJob,
  onUploadStarted,
  onActionCompleted,
  refreshNonce = 0,
  fetcher,
}: JobPageProps) {
  const jobPath = `/recruitment/api/recruiting/jobs/${encodeURIComponent(jobId)}`;
  const routeKey = `job:${jobId}`;
  const [vm, setVm] = useState<JobCanvasVM | null>(() => {
    const cached = getCachedCanvasData(jobPath);
    return cached !== undefined ? normalizeJobDetail(cached) : null;
  });
  const [loading, setLoading] = useState<boolean>(() => getCachedCanvasData(jobPath) === undefined);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tab, setTab] = useState<JobTab>('pipeline');
  const [stageFilter, setStageFilter] = useState<StageFilter>('全部');
  const [focusedSection, setFocusedSection] = useState<string | null>(null);
  const lastFocusNonceRef = useRef<number>(0);
  const focusRaf1Ref = useRef<number | null>(null);
  const focusRaf2Ref = useRef<number | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // T5-1: Multi-select + real batch reject (never deletes locally; refreshes from server)
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState<boolean>(false);
  const [batchDimKey, setBatchDimKey] = useState<string>('');
  const [batchReasonDetail, setBatchReasonDetail] = useState<string>('核心项目深度不足');
  const [batchConfirm, setBatchConfirm] = useState<string>('');
  const [batchSubmitting, setBatchSubmitting] = useState<boolean>(false);
  const [batchResults, setBatchResults] = useState<BatchRejectItemResult[] | null>(null);

  // T4-2: Upload resume + Create job (no headcount!)
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [newJobTitle, setNewJobTitle] = useState<string>('');
  const [newJobDept, setNewJobDept] = useState<string>('');
  const [newJobConfirm, setNewJobConfirm] = useState<string>('');
  const [creating, setCreating] = useState<boolean>(false);
  const [rubricApproveOpen, setRubricApproveOpen] = useState<boolean>(false);
  const [rubricApproveReason, setRubricApproveReason] = useState<string>('');
  const [rubricApproving, setRubricApproving] = useState<boolean>(false);
  const [closeJobOpen, setCloseJobOpen] = useState<boolean>(false);
  const [closeJobReason, setCloseJobReason] = useState<string>('');
  const [closingJob, setClosingJob] = useState<boolean>(false);
  const [compareOpen, setCompareOpen] = useState<boolean>(false);
  const [compareLoading, setCompareLoading] = useState<boolean>(false);
  const [compareItems, setCompareItems] = useState<CandidateCanvasVM[]>([]);
  const [compareCopyNotice, setCompareCopyNotice] = useState<string>('');
  const [rediscoveryList, setRediscoveryList] = useState<
    Array<{
      readonly candidateId: string;
      readonly candidateName: string;
      readonly matchedCount: number;
      readonly basisLabels: readonly string[];
    }>
  >([]);
  const [feedback, setFeedback] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);

  const load = useCallback(
    async (cancelledRef?: { current: boolean }, opts?: { silent?: boolean }) => {
      const cached = getCachedCanvasData(jobPath);
      const hasContent = opts?.silent || cached !== undefined;
      if (cached !== undefined && !opts?.silent) {
        const fast = normalizeJobDetail(cached);
        setVm(fast);
        setBatchDimKey((prev) => prev || fast.rubricDimensions[0]?.key || '');
      }
      if (hasContent) setSyncing(true);
      else setLoading(true);
      setError(null);
      try {
        const raw = await fetcher(jobPath);
        if (cancelledRef?.current) return;
        setCachedCanvasData(jobPath, raw);
        const next = normalizeJobDetail(raw);
        setVm(next);
        setBatchDimKey((prev) => prev || next.rubricDimensions[0]?.key || '');
      } catch {
        if (cancelledRef?.current) return;
        if (!hasContent) setError('暂时没能读取到该岗位的详细资料，请稍后重试。');
      } finally {
        if (!cancelledRef?.current) {
          setLoading(false);
          setSyncing(false);
        }
      }
    },
    [jobPath, fetcher],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    void load(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [load, refreshNonce]);

  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el || loading) return;
    el.scrollTop = getSavedCanvasScroll(routeKey);
  }, [routeKey, loading]);

  useEffect(() => {
    return () => {
      if (focusRaf1Ref.current !== null) cancelAnimationFrame(focusRaf1Ref.current);
      if (focusRaf2Ref.current !== null) cancelAnimationFrame(focusRaf2Ref.current);
      if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    };
  }, []);

  // Read-only section focus & highlight (driven by Agent ui_action focus_section)
  useEffect(() => {
    if (!focusRequest || loading || !vm) return;
    if (focusRequest.nonce === lastFocusNonceRef.current) return;
    let targetSec: 'rubric' | 'candidates' | null = null;
    if (focusRequest.section === 'rubric' || focusRequest.section === 'criteria') {
      targetSec = 'rubric';
      setTab('rubric');
    } else if (focusRequest.section === 'candidates' || focusRequest.section === 'summary') {
      targetSec = 'candidates';
      setTab('pipeline');
    }
    if (!targetSec) return;
    lastFocusNonceRef.current = focusRequest.nonce;
    setFocusedSection(targetSec);
    if (focusRaf1Ref.current !== null) cancelAnimationFrame(focusRaf1Ref.current);
    if (focusRaf2Ref.current !== null) cancelAnimationFrame(focusRaf2Ref.current);
    if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    focusRaf1Ref.current = requestAnimationFrame(() => {
      focusRaf1Ref.current = null;
      focusRaf2Ref.current = requestAnimationFrame(() => {
        focusRaf2Ref.current = null;
        const target = bodyScrollRef.current?.querySelector(`[data-section="${targetSec}"]`);
        if (target && typeof (target as HTMLElement).scrollIntoView === 'function') {
          (target as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null;
      setFocusedSection((cur) => (cur === targetSec ? null : cur));
    }, 1800);
    onFocusConsumed?.();
  }, [focusRequest, loading, vm, onFocusConsumed]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!onBack || batchOpen || createOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack, batchOpen, createOpen]);

  const scheduleRowPrefetch = (applicationId: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      prefetchCanvasPath(`/recruitment/api/recruiting/applications/${encodeURIComponent(applicationId)}`, fetcher);
    }, 120);
  };

  const cancelRowPrefetch = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const toggleSelect = (appId: string) => {
    setSelectedIds((prev) => (prev.includes(appId) ? prev.filter((x) => x !== appId) : [...prev, appId]));
  };

  const openBatchRejectModal = () => {
    if (!vm || selectedIds.length === 0) return;
    setFeedback(null);
    setBatchResults(null);
    setBatchDimKey(vm.rubricDimensions[0]?.key || '');
    setBatchConfirm(`确认批量关闭已选 ${selectedIds.length} 位候选人的申请`);
    setBatchOpen(true);
  };

  const handleBatchRejectSubmit = async () => {
    if (!vm || batchSubmitting || selectedIds.length === 0) return;
    const confirmationText = batchConfirm.trim();
    if (!confirmationText) {
      setFeedback({ tone: 'red', text: '请先填写确认原话后再提交。' });
      return;
    }
    const reasonStr = batchDimKey
      ? `${batchDimKey}：${batchReasonDetail.trim() || '未满足岗位要求'}`
      : batchReasonDetail.trim() || '未满足岗位要求';

    setBatchSubmitting(true);
    setFeedback(null);
    try {
      const res = await postBatchReject({
        applicationIds: selectedIds,
        reason: reasonStr,
        confirmationText,
      });
      setBatchOpen(false);
      setSelectedIds([]);
      setBatchResults(res.results);
      // Invalidate affected candidate caches + job cache, then refresh silently
      selectedIds.forEach((id) => invalidateCachedCanvasData(`/recruitment/api/recruiting/applications/${encodeURIComponent(id)}`));
      invalidateCachedCanvasData(jobPath);
      await load(undefined, { silent: true });
      if (res.failedCount === 0) {
        const msg = `已批量关闭 ${res.succeededCount} 位候选人申请`;
        setFeedback({ tone: 'green', text: msg });
        onActionCompleted?.({ message: msg, actionId: res.actionId });
      } else {
        const msg = `已完成 ${res.succeededCount} 位，另有 ${res.failedCount} 位未能关闭（请看下方逐条原因）`;
        setFeedback({ tone: 'red', text: msg });
        if (res.actionId) onActionCompleted?.({ message: msg, actionId: res.actionId });
      }
    } catch (err) {
      const msg = (err as CanvasActionError)?.userMessage || '批量不通过未能完成，请稍后重试。';
      setFeedback({ tone: 'red', text: msg });
    } finally {
      setBatchSubmitting(false);
    }
  };

  // Issue #60：按当前岗位导出人话 CSV（同源 + session，真实 HTTP 失败如实提示）。
  const handleExportCsv = async () => {
    setFeedback(null);
    try {
      const sid = sessionId || getCanvasSessionId();
      await downloadApplicationsCsv(sid, jobId);
      setFeedback({ tone: 'green', text: '已导出本岗位申请 CSV（联系方式已脱敏）。' });
    } catch (err) {
      setFeedback({ tone: 'red', text: err instanceof Error ? err.message : '导出失败' });
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !vm || uploading) return;
    setUploading(true);
    setFeedback(null);
    try {
      const started = await uploadResumeRaw(file, vm.jobId);
      onUploadStarted?.(started);
    } catch (err) {
      const msg = (err as CanvasActionError)?.userMessage || '简历上传未能提交，请稍后重试。';
      setFeedback({ tone: 'red', text: msg });
    } finally {
      setUploading(false);
    }
  };

  const handleApproveRubric = async () => {
    if (!vm || rubricApproving) return;
    const action = vm.actions.rubric_approve;
    if (!action || !action.available || action.seam === '') {
      setFeedback({
        tone: 'red',
        text: action?.reasonText || action?.pendingText || '当前岗位标准暂不可批准。',
      });
      setRubricApproveOpen(false);
      return;
    }
    const activeSessionId = (sessionId ?? '').trim() || getCanvasSessionId();
    const built = buildRubricApproveBody({
      jobId: vm.jobId,
      rubricVersionId: vm.rubricVersionId,
      reason: rubricApproveReason.trim() || undefined,
    });
    if (!built.ok) {
      setFeedback({ tone: 'red', text: built.reasonText });
      return;
    }
    setRubricApproving(true);
    try {
      const outcome = await postActionSeam(action, built.body, activeSessionId);
      if (!outcome.accepted) {
        setFeedback({
          tone: 'red',
          text:
            outcome.error?.message ||
            describeActionError(outcome.error?.code ?? '', outcome.error?.reasonCode ?? '') ||
            '批准评分标准未能完成，请稍后重试。',
        });
        return;
      }
      setRubricApproveOpen(false);
      setRubricApproveReason('');
      setFeedback({ tone: 'green', text: `已批准岗位评分标准 ${vm.rubricVersionLabel}。`, });
      invalidateCachedCanvasData(jobPath);
      void load(undefined, { silent: true });
      onActionCompleted?.({ message: `已批准岗位评分标准 ${vm.rubricVersionLabel}` });
    } catch (err) {
      setFeedback({
        tone: 'red',
        text: err instanceof Error ? err.message : '批准评分标准未能完成，请稍后重试。',
      });
    } finally {
      setRubricApproving(false);
    }
  };

  const handleCloseJob = async () => {
    if (!vm || closingJob) return;
    const activeSessionId = (sessionId ?? '').trim() || getCanvasSessionId();
    const reason = closeJobReason.trim();
    const built = buildJobCloseBody({ jobId: vm.jobId, reason });
    if (!built.ok) {
      setFeedback({ tone: 'red', text: built.reasonText });
      return;
    }
    setClosingJob(true);
    try {
      const outcome = await postJobClose(vm.jobId, reason, activeSessionId);
      if (!outcome.accepted) {
        setFeedback({
          tone: 'red',
          text:
            outcome.error?.message ||
            describeActionError(outcome.error?.code ?? '', outcome.error?.reasonCode ?? '') ||
            '关闭岗位未能完成，请稍后重试。',
        });
        return;
      }
      setCloseJobOpen(false);
      setCloseJobReason('');
      setFeedback({ tone: 'green', text: `已关闭岗位「${vm.title}」。` });
      invalidateCachedCanvasData(jobPath);
      void load(undefined, { silent: true });
      onActionCompleted?.({ message: `已关闭岗位「${vm.title}」` });
    } catch (err) {
      setFeedback({
        tone: 'red',
        text: err instanceof Error ? err.message : '关闭岗位未能完成，请稍后重试。',
      });
    } finally {
      setClosingJob(false);
    }
  };


  useEffect(() => {
    let active = true;
    fetcher(`/recruitment/api/recruiting/jobs/${encodeURIComponent(jobId)}/rediscovery`)
      .then((raw) => {
        if (!active || !raw || typeof raw !== 'object') return;
        const obj = raw as Record<string, unknown>;
        const list = Array.isArray(obj.candidates) ? obj.candidates : [];
        const parsed = list
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const rec = item as Record<string, unknown>;
            const candidateId = typeof rec.candidate_id === 'string' ? rec.candidate_id : '';
            const candidateName = typeof rec.candidate_name === 'string' ? rec.candidate_name : '';
            if (!candidateId || !candidateName) return null;
            const matchedCount =
              typeof rec.matched_condition_count === 'number' ? rec.matched_condition_count : 0;
            const basisRaw = Array.isArray(rec.basis) ? rec.basis : [];
            const basisLabels = basisRaw
              .map((b) =>
                b && typeof b === 'object' && typeof (b as Record<string, unknown>).label === 'string'
                  ? String((b as Record<string, unknown>).label)
                  : '',
              )
              .filter(Boolean)
              .slice(0, 3);
            return { candidateId, candidateName, matchedCount, basisLabels };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        setRediscoveryList(parsed);
      })
      .catch(() => {
        if (active) setRediscoveryList([]);
      });
    return () => {
      active = false;
    };
  }, [jobId, fetcher, refreshNonce]);

  const handleOpenCompare = async () => {
    const ids = selectedIds.slice(0, 3);
    if (ids.length < 2) return;
    setCompareOpen(true);
    setCompareLoading(true);
    setCompareCopyNotice('');
    try {
      const results = await Promise.all(
        ids.map((id) =>
          fetcher(`/recruitment/api/recruiting/applications/${encodeURIComponent(id)}`).then(
            (raw) => normalizeApplicationDetail(raw),
          ),
        ),
      );
      setCompareItems(results);
    } catch {
      setCompareItems([]);
      setFeedback({ tone: 'red', text: '读取候选人对比信息失败，请稍后重试。' });
      setCompareOpen(false);
    } finally {
      setCompareLoading(false);
    }
  };

  const handleCopyCompareSummary = async () => {
    if (!vm || compareItems.length === 0) return;
    const lines: string[] = [`【候选人横向对比】岗位：${vm.title}`, ''];
    for (const item of compareItems) {
      lines.push(`- ${item.candidateName}（${item.stageLabel}）`);
      if (item.summaryText) lines.push(`  提炼：${item.summaryText}`);
      for (const cr of item.criteria) {
        lines.push(`  · ${cr.label}：${cr.statusText}`);
      }
      lines.push('');
    }
    const text = lines.join('\n').trim();
    try {
      await navigator.clipboard.writeText(text);
      setCompareCopyNotice('已复制横向对比摘要，可直接发给用人经理。');
    } catch {
      setCompareCopyNotice('剪贴板不可用，请手动选中复制。');
    }
  };

  const handleCreateJob = async () => {
    if (creating) return;
    const title = newJobTitle.trim();
    const activeSessionId = (sessionId ?? '').trim() || getCanvasSessionId();
    if (!title) {
      setFeedback({ tone: 'red', text: '请先填写岗位名称。' });
      return;
    }
    const deptId = newJobDept.trim() || vm?.departmentId || '';
    const code = `JOB-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const built = buildJobCreateBody({
      code,
      title,
      departmentId: deptId,
      descriptionMd: title,
      requirementsMd: newJobConfirm.trim() || title,
      criteria: [
        {
          key: 'work_history_present',
          label: '有可核对的工作经历',
          kind: 'MUST_HAVE',
          weight: 0.5,
          field: 'work_experience',
          operator: 'EXISTS',
          value: true,
        },
        {
          key: 'core_fit',
          label: '核心岗位胜任力匹配',
          kind: 'MUST_HAVE',
          weight: 0.5,
          question: '候选人过往经历与核心职责是否与该岗位要求高度匹配？',
        },
      ],
      status: 'DRAFT',
    });
    if (!built.ok) {
      setFeedback({ tone: 'red', text: built.reasonText });
      return;
    }
    setCreating(true);
    setFeedback(null);
    try {
      const outcome = await postJobCreate(built.body, activeSessionId);
      if (!outcome.accepted) {
        setFeedback({
          tone: 'red',
          text: outcome.error?.message || describeActionError(outcome.error?.code ?? '', outcome.error?.reasonCode ?? '') || '新建岗位未能完成，请稍后重试。',
        });
        return;
      }
      setCreateOpen(false);
      setNewJobTitle('');
      setNewJobDept('');
      setNewJobConfirm('');
      const msg = `已创建岗位「${title}」（标准待审批），可继续完善岗位标准。`;
      setFeedback({ tone: 'green', text: msg });
      const createdJobId =
        outcome.payload && typeof outcome.payload.job_id === 'string'
          ? outcome.payload.job_id
          : undefined;
      const actionId =
        outcome.payload && typeof outcome.payload.action_id === 'string'
          ? outcome.payload.action_id
          : undefined;
      onActionCompleted?.({ message: msg, actionId });
      if (createdJobId && onSelectJob) {
        onSelectJob(createdJobId);
      }
    } catch (err) {
      const msg = (err as CanvasActionError)?.userMessage || '新建岗位未能完成，请稍后重试。';
      setFeedback({ tone: 'red', text: msg });
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <>
        <header className="ros-canvas-head">
          <div className="ros-head-left">
            {onBack ? (
              <button type="button" className="ros-crumb-link" onClick={onBack}>
                ← 返回
              </button>
            ) : null}
            <span className="ros-crumb-cur">岗位详情</span>
          </div>
        </header>
        <div className="ros-canvas-body">
          <div className="ros-canvas-inner">
            <CanvasLoadingState label="正在读取岗位标准与候选人漏斗…" />
          </div>
        </div>
      </>
    );
  }

  if (error || !vm) {
    return (
      <>
        <header className="ros-canvas-head">
          <div className="ros-head-left">
            {onBack ? (
              <button type="button" className="ros-crumb-link" onClick={onBack}>
                ← 返回
              </button>
            ) : null}
            <span className="ros-crumb-cur">岗位详情</span>
          </div>
        </header>
        <div className="ros-canvas-body">
          <div className="ros-canvas-inner">
            <CanvasErrorState message={error || undefined} onRetry={() => void load()} />
          </div>
        </div>
      </>
    );
  }

  const filteredApps = vm.applications.filter(
    (app) => stageFilter === '全部' || app.filterBucket === stageFilter,
  );
  const nameById = new Map(vm.applications.map((a) => [a.applicationId, a.candidateName]));

  return (
    <>
      <header className="ros-canvas-head">
        <div className="ros-head-left">
          <div className="ros-crumb-bar">
            {onBack ? (
              <>
                <button type="button" className="ros-crumb-link" onClick={onBack}>
                  ← 返回
                </button>
                <span>/</span>
              </>
            ) : null}
            <span className="ros-crumb-cur">{vm.title}</span>
          </div>
          <div className="ros-tabs" style={{ marginLeft: 8 }}>
            <button
              type="button"
              className={`ros-tab ${tab === 'pipeline' ? 'active' : ''}`}
              onClick={() => setTab('pipeline')}
            >
              候选人漏斗
            </button>
            <button
              type="button"
              className={`ros-tab ${tab === 'rubric' ? 'active' : ''}`}
              onClick={() => setTab('rubric')}
            >
              岗位标准 {vm.rubricVersionLabel}
            </button>
          </div>
        </div>
        <div className="ros-head-right" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {syncing ? <span className="ros-sync-pill"><i className="ros-sync-dot" />同步中</span> : null}
          <FactLabelsBar labels={vm.factLabels} />
        </div>
      </header>

      <div className="ros-canvas-body" ref={bodyScrollRef} onScroll={(e) => saveCanvasScroll(routeKey, e.currentTarget.scrollTop)}>
        <div key={jobId} className="ros-canvas-inner ros-canvas-enter">
          {feedback ? (
            <div
              className="ros-risk-note"
              role="status"
              style={{
                borderLeftColor: feedback.tone === 'green' ? 'var(--green)' : 'var(--red)',
                color: feedback.tone === 'green' ? 'var(--green)' : 'var(--red)',
                background: feedback.tone === 'green' ? 'var(--green-soft)' : 'var(--red-soft)',
              }}
            >
              {feedback.text}
            </div>
          ) : null}

          {batchResults && batchResults.length > 0 ? (
            <div className="ros-doc-block" data-testid="batch-reject-results">
              <div className="ros-sec-head" style={{ marginBottom: 4 }}>
                <span className="ros-sec-meta">本次批量处理逐条结果</span>
                <button type="button" className="ros-text-link" onClick={() => setBatchResults(null)}>
                  收起
                </button>
              </div>
              <div className="ros-clean-list">
                {batchResults.map((item) => (
                  <div key={item.applicationId} className="ros-clean-row static" style={{ padding: '9px 4px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>
                      {nameById.get(item.applicationId) || '候选人'}
                    </span>
                    <StatusLabel
                      text={item.ok ? item.message || '已关闭' : `未关闭：${item.message}`}
                      tone={item.ok ? 'green' : 'red'}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* 岗位头与 6 阶段进度 */}
          <div className="ros-doc-head">
            <div>
              <div className="ros-doc-name">{vm.title}</div>
              <div className="ros-doc-meta">
                {vm.departmentName} · 岗位编号 <span className="num">{vm.jobCode}</span> · 在途{' '}
                <span className="num">{vm.activeApplications}</span> / 总计{' '}
                <span className="num">{vm.totalApplications}</span> 人
              </div>
            </div>
            <StatusLabel text={vm.statusLabel} tone={vm.statusLabel === '招聘中' ? 'green' : ''} />
          </div>

          <StageTrack nodes={vm.stageTrack} />

          {vm.nextStepLabel ? <div className="ros-risk-note">{vm.nextStepLabel}</div> : null}

          {tab === 'pipeline' ? (
            <div
              data-section="candidates"
              className={focusedSection === 'candidates' ? 'ros-section-focus' : undefined}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 16,
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {STAGE_FILTERS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={`ros-text-link ${stageFilter === f ? 'active' : ''}`}
                      onClick={() => {
                        setStageFilter(f);
                        setSelectedIds([]);
                      }}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.doc,.docx,.rtf,.txt"
                    style={{ display: 'none' }}
                    onChange={(e) => void handleFileChange(e)}
                  />
                  <button
                    type="button"
                    className="ros-text-link"
                    disabled={uploading}
                    data-testid="canvas-action-upload"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? '上传中…' : '导入简历'}
                  </button>
                  <button
                    type="button"
                    className="ros-text-link"
                    data-testid="canvas-action-export-csv"
                    onClick={() => void handleExportCsv()}
                  >
                    导出 CSV
                  </button>
                  <button
                    type="button"
                    className="ros-text-link"
                    data-testid="canvas-action-new-job"
                    onClick={() => {
                      setFeedback(null);
                      setNewJobConfirm('确认新建招聘岗位');
                      setCreateOpen(true);
                    }}
                  >
                    新建岗位
                  </button>
                  <span className="ros-sec-meta num">{filteredApps.length} 人</span>
                </div>
              </div>

              {filteredApps.length > 0 ? (
                <div className="ros-clean-list">
                  {filteredApps.map((app) => {
                    const checked = selectedIds.includes(app.applicationId);
                    return (
                      <div
                        key={app.applicationId}
                        className="ros-clean-row"
                        onMouseEnter={() => scheduleRowPrefetch(app.applicationId)}
                        onMouseLeave={cancelRowPrefetch}
                        onClick={() => onSelectApplication?.(app.applicationId, filteredApps.map((x) => x.applicationId))}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectApplication?.(app.applicationId, filteredApps.map((x) => x.applicationId));
                          }
                        }}
                      >
                        <div className="ros-cr-left">
                          <input
                            type="checkbox"
                            checked={checked}
                            aria-label={`选择 ${app.candidateName}`}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelect(app.applicationId)}
                            style={{ cursor: 'pointer' }}
                          />
                          <span className="ros-mono">{app.candidateName.slice(0, 1)}</span>
                          <span className="ros-cr-name">
                            {app.candidateName}
                            <span className="ros-cr-role">{app.metaText}</span>
                          </span>
                        </div>
                        <StatusLabel text={app.stageLabel} tone={app.statusTone} />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <CanvasEmptyState title="当前阶段暂无候选人" description="切换上方筛选条件可查看其他阶段候选人。" />
              )}

              {rediscoveryList.length > 0 ? (
                <div
                  data-testid="canvas-job-rediscovery"
                  style={{
                    marginTop: 28,
                    paddingTop: 20,
                    borderTop: '1px solid var(--line-soft)',
                  }}
                >
                  <div className="ros-sec-head" style={{ marginBottom: 8 }}>
                    <span className="ros-sec-title">历史人才库再发现</span>
                    <span className="ros-sec-meta num">
                      仅按历史事实召回（不评分、不排名）· {rediscoveryList.length} 人
                    </span>
                  </div>
                  <div className="ros-clean-list">
                    {rediscoveryList.map((cand) => (
                      <div key={cand.candidateId} className="ros-clean-row static">
                        <span style={{ fontSize: '13.5px', fontWeight: 500, color: 'var(--ink)' }}>
                          {cand.candidateName}
                        </span>
                        <span className="ros-sec-meta">
                          {cand.basisLabels.length > 0
                            ? cand.basisLabels.join(' · ')
                            : `命中 ${cand.matchedCount} 条历史事实`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedIds.length > 0 ? (
                <div className="ros-batch-float" data-testid="canvas-batch-float">
                  <span className="num">已选 {selectedIds.length} 人</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {selectedIds.length >= 2 && selectedIds.length <= 3 ? (
                      <button
                        type="button"
                        data-testid="canvas-batch-compare-open"
                        style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)' }}
                        onClick={() => void handleOpenCompare()}
                      >
                        横向对比 ({selectedIds.length})
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid="canvas-batch-reject-open"
                      style={{ background: 'var(--red)', color: '#fff' }}
                      onClick={openBatchRejectModal}
                    >
                      批量不通过
                    </button>
                    <button type="button" onClick={() => setSelectedIds([])}>
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div
                data-section="rubric"
                className={focusedSection === 'rubric' ? 'ros-section-focus' : undefined}
              >
                <div className="ros-sec-head">
                  <span className="ros-sec-title">
                    考核维度与标准 {vm.rubricVersionLabel}（{vm.rubricApproved ? '已锁定' : '待确认'}）
                  </span>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
                    <span className="ros-sec-meta">{vm.departmentName}</span>
                    {!vm.rubricApproved && vm.actions.rubric_approve?.available ? (
                      <button
                        type="button"
                        className="ros-btn dark"
                        data-testid="canvas-action-rubric-approve"
                        onClick={() => {
                          setRubricApproveReason('');
                          setRubricApproveOpen(true);
                        }}
                      >
                        批准当前标准
                      </button>
                    ) : null}
                  </div>
                </div>
                {vm.rubricDimensions.length > 0 ? (
                  <div className="ros-clean-list">
                    {vm.rubricDimensions.map((dim, idx) => (
                      <div key={dim.key} className="ros-clean-row static">
                        <div>
                          <span style={{ fontSize: '14px', color: 'var(--ink)' }}>
                            <span className="num" style={{ color: 'var(--soft)', marginRight: 10 }}>
                              0{idx + 1}
                            </span>
                            {dim.label}
                          </span>
                          <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: 2, marginLeft: 26 }}>
                            {dim.kindLabel}
                            {dim.weightText ? ` · ${dim.weightText}` : ''}
                            {dim.question ? ` · 建议核实：${dim.question}` : ''}
                          </div>
                        </div>
                        <StatusLabel text={vm.rubricApproved ? '生效中' : '草稿'} tone={vm.rubricApproved ? 'green' : 'amber'} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <CanvasEmptyState title="尚未配置考核维度" />
                )}
              </div>

              <div>
                <div className="ros-sec-head">
                  <span className="ros-sec-title">岗位原始信息（完整 JD）</span>
                  <span className="ros-sec-meta num">{vm.jobCode}</span>
                </div>
                {vm.descriptionMd || vm.requirementsMd ? (
                  <div className="ros-jd-box">
                    {vm.descriptionMd ? (
                      <div>
                        <div className="ros-jd-sec-t">岗位职责</div>
                        <div>{vm.descriptionMd}</div>
                      </div>
                    ) : null}
                    {vm.requirementsMd ? (
                      <div>
                        <div className="ros-jd-sec-t">任职要求</div>
                        <div>{vm.requirementsMd}</div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <CanvasEmptyState title="暂无岗位原始描述" />
                )}
                {vm.statusLabel !== '已关闭' && vm.statusLabel !== '已结束' ? (
                  <div
                    style={{
                      marginTop: 32,
                      paddingTop: 16,
                      borderTop: '1px solid var(--line-soft)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                      岗位不再接收新候选人时，可在此关闭并归档。
                    </span>
                    <button
                      type="button"
                      className="ros-text-link"
                      style={{ color: 'var(--red)' }}
                      data-testid="canvas-action-job-close"
                      onClick={() => {
                        setCloseJobReason('');
                        setCloseJobOpen(true);
                      }}
                    >
                      关闭岗位
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Centered Batch-Reject Confirmation Modal (T5-1) */}
      {batchOpen ? (
        <div
          className="ros-modal-bg"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !batchSubmitting) setBatchOpen(false);
          }}
        >
          <div className="ros-modal">
            <div style={{ fontSize: '17px', fontWeight: 650 }}>
              批量关闭 {selectedIds.length} 位申请
            </div>
            <div className="ros-jd-box" style={{ padding: '12px 14px' }}>
              关闭后不再触发后续排期提醒；如有部分候选人已不在可决策状态，将逐条如实提示原因，5 分钟内支持撤销。
            </div>
            {vm.rubricDimensions.length > 0 ? (
              <label className="ros-m-field">
                <span>关联考核维度（必填）</span>
                <select
                  value={batchDimKey}
                  onChange={(e) => setBatchDimKey(e.target.value)}
                  style={{
                    padding: '9px 11px',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                    background: 'var(--surface)',
                    color: 'var(--ink)',
                  }}
                >
                  {vm.rubricDimensions.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="ros-m-field">
              <span>不通过原因说明</span>
              <input
                value={batchReasonDetail}
                onChange={(e) => setBatchReasonDetail(e.target.value)}
                placeholder="例如：核心项目深度不足"
              />
            </label>
            <label className="ros-m-field">
              <span>确认原话（留痕必填）</span>
              <input
                value={batchConfirm}
                onChange={(e) => setBatchConfirm(e.target.value)}
                placeholder="输入一句确认原话"
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="ros-btn"
                disabled={batchSubmitting}
                onClick={() => setBatchOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="ros-btn dark"
                disabled={batchSubmitting}
                data-testid="canvas-batch-reject-submit"
                onClick={() => void handleBatchRejectSubmit()}
              >
                {batchSubmitting ? '处理中…' : '确认关闭'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Centered Create-Job Confirmation Modal (no headcount field) */}
      {createOpen ? (
        <div
          className="ros-modal-bg"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !creating) setCreateOpen(false);
          }}
        >
          <div className="ros-modal">
            <div style={{ fontSize: '17px', fontWeight: 650 }}>新建招聘岗位</div>
            <div className="ros-jd-box" style={{ padding: '12px 14px' }}>
              新建后岗位标准将处于待审批状态；HC 配额由岗位需求单维护。
            </div>
            <label className="ros-m-field">
              <span>岗位名称</span>
              <input
                value={newJobTitle}
                onChange={(e) => setNewJobTitle(e.target.value)}
                placeholder="例如：资深后端工程师"
              />
            </label>
            <label className="ros-m-field">
              <span>所属部门（选填）</span>
              <input
                value={newJobDept}
                onChange={(e) => setNewJobDept(e.target.value)}
                placeholder="例如：研发中心"
              />
            </label>
            <label className="ros-m-field">
              <span>确认原话（留痕必填）</span>
              <input
                value={newJobConfirm}
                onChange={(e) => setNewJobConfirm(e.target.value)}
                placeholder="输入一句确认原话"
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="ros-btn"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="ros-btn dark"
                disabled={creating}
                data-testid="canvas-create-job-submit"
                onClick={() => void handleCreateJob()}
              >
                {creating ? '处理中…' : '确认创建'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rubricApproveOpen ? (
        <div
          className="ros-modal-bg"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !rubricApproving) setRubricApproveOpen(false);
          }}
        >
          <div className="ros-modal">
            <div style={{ fontSize: '17px', fontWeight: 650 }}>
              批准岗位评分标准 {vm.rubricVersionLabel}
            </div>
            <div className="ros-jd-box" style={{ padding: '12px 14px' }}>
              批准后，该版本标准将作为「{vm.title}」初筛与面试评估的锁定口径。
            </div>
            <label className="ros-m-field">
              <span>审批备注（选填）</span>
              <input
                value={rubricApproveReason}
                onChange={(e) => setRubricApproveReason(e.target.value)}
                placeholder="例如：与用人经理对齐，确认启用"
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="ros-btn"
                disabled={rubricApproving}
                onClick={() => setRubricApproveOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="ros-btn dark"
                disabled={rubricApproving}
                data-testid="canvas-rubric-approve-submit"
                onClick={() => void handleApproveRubric()}
              >
                {rubricApproving ? '提交中…' : '确认批准'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {compareOpen ? (
        <div
          className="ros-modal-bg"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCompareOpen(false);
          }}
        >
          <div className="ros-modal" style={{ maxWidth: 780, width: '92vw' }} data-testid="canvas-compare-modal">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: '17px', fontWeight: 650 }}>
                候选人横向对比 · {vm.title}
              </div>
              <span className="ros-sec-meta num">{compareItems.length} 位候选人</span>
            </div>
            {compareLoading ? (
              <div className="ros-sec-meta" style={{ padding: '24px 0' }}>正在加载候选人对照信息…</div>
            ) : compareItems.length > 0 ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px 10px 8px 0', borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontWeight: 500 }}>
                        对照维度
                      </th>
                      {compareItems.map((item) => (
                        <th key={item.applicationId} style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--line)', color: 'var(--ink)', fontWeight: 600 }}>
                          {item.candidateName}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ padding: '9px 10px 9px 0', borderBottom: '1px solid var(--line-soft)', color: 'var(--muted)' }}>当前阶段</td>
                      {compareItems.map((item) => (
                        <td key={item.applicationId} style={{ padding: '9px 10px', borderBottom: '1px solid var(--line-soft)', color: 'var(--text)' }}>
                          {item.stageLabel}
                        </td>
                      ))}
                    </tr>
                    {vm.rubricDimensions.map((dim) => (
                      <tr key={dim.key}>
                        <td style={{ padding: '9px 10px 9px 0', borderBottom: '1px solid var(--line-soft)', color: 'var(--muted)' }}>
                          {dim.label}
                        </td>
                        {compareItems.map((item) => {
                          const matched = item.criteria.find((c) => c.key === dim.key);
                          return (
                            <td key={item.applicationId} style={{ padding: '9px 10px', borderBottom: '1px solid var(--line-soft)' }}>
                              {matched ? (
                                <StatusLabel text={matched.statusText} tone={matched.level} />
                              ) : (
                                <span style={{ color: 'var(--soft)' }}>待评估</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {compareCopyNotice ? (
              <div style={{ fontSize: 12, color: 'var(--green)' }}>{compareCopyNotice}</div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="ros-btn"
                data-testid="canvas-compare-copy"
                disabled={compareLoading || compareItems.length === 0}
                onClick={() => void handleCopyCompareSummary()}
              >
                复制摘要给用人经理
              </button>
              <button
                type="button"
                className="ros-btn dark"
                onClick={() => setCompareOpen(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {closeJobOpen ? (
        <div
          className="ros-modal-bg"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !closingJob) setCloseJobOpen(false);
          }}
        >
          <div className="ros-modal">
            <div style={{ fontSize: '17px', fontWeight: 650 }}>关闭岗位「{vm.title}」</div>
            <div className="ros-jd-box" style={{ padding: '12px 14px' }}>
              关闭后该岗位状态将变更为已关闭，历史候选人与决策留痕完整保留。
            </div>
            <label className="ros-m-field">
              <span>关闭原因（选填）</span>
              <input
                value={closeJobReason}
                onChange={(e) => setCloseJobReason(e.target.value)}
                placeholder="例如：岗位已招满 / 暂停招聘"
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="ros-btn"
                disabled={closingJob}
                onClick={() => setCloseJobOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="ros-btn"
                style={{ color: 'var(--red)', borderColor: 'rgba(205, 43, 49, 0.35)' }}
                disabled={closingJob}
                data-testid="canvas-job-close-submit"
                onClick={() => void handleCloseJob()}
              >
                {closingJob ? '提交中…' : '确认关闭岗位'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
