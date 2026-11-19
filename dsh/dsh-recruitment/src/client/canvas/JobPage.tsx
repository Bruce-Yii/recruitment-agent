import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeJobDetail,
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
import type { ActiveUploadTask, UndoToastPayload } from './CanvasRoute.tsx';
import {
  buildJobCreateBody,
  describeActionError,
  getCanvasSessionId,
  postBatchReject,
  postJobCreate,
  uploadResumeRaw,
  type BatchRejectItemResult,
  type CanvasActionError,
} from './canvas-actions.ts';

export interface JobPageProps {
  readonly sessionId?: string;
  jobId: string;
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
      criteria: [{ key: 'core_fit', label: '核心岗位匹配度', kind: 'MUST_HAVE', weight: 1 }],
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
      if (!outcome.ok) {
        setFeedback({
          tone: 'red',
          text: outcome.message || describeActionError(outcome.code, outcome.reasonCode) || '新建岗位未能完成，请稍后重试。',
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
            <div>
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

              {selectedIds.length > 0 ? (
                <div className="ros-batch-float" data-testid="canvas-batch-float">
                  <span className="num">已选 {selectedIds.length} 人</span>
                  <div style={{ display: 'flex', gap: 8 }}>
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
              <div>
                <div className="ros-sec-head">
                  <span className="ros-sec-title">
                    考核维度与标准 {vm.rubricVersionLabel}（{vm.rubricApproved ? '已锁定' : '待确认'}）
                  </span>
                  <span className="ros-sec-meta">{vm.departmentName}</span>
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
    </>
  );
}
