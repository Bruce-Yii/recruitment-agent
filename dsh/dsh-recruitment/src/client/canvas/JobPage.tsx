import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeJobDetail,
  type JobApplicationRowVM,
  type JobCanvasVM,
} from '../normalize-canvas.ts';
import {
  CanvasEmptyState,
  CanvasErrorState,
  CanvasLoadingState,
  FactLabelsBar,
  StageTrack,
  StatusLabel,
} from './bits/index.ts';
import type { CanvasFetcher } from './CandidatePage.tsx';
import type { ActiveUploadTask } from './CanvasRoute.tsx';
import {
  postJobCreate,
  uploadResumeRaw,
  type CanvasActionError,
} from './canvas-actions.ts';

export interface JobPageProps {
  jobId: string;
  onBack?: () => void;
  onSelectApplication?: (applicationId: string) => void;
  onSelectJob?: (jobId: string) => void;
  onUploadStarted?: (task: ActiveUploadTask) => void;
  /** Incrementing key triggered when an async upload completes to refresh the list. */
  refreshNonce?: number;
  fetcher: CanvasFetcher;
}

type JobTab = 'pipeline' | 'rubric';
type StageFilter = '全部' | JobApplicationRowVM['filterBucket'];

const STAGE_FILTERS: StageFilter[] = ['全部', '接入', '初筛', '面试中', '终审与 Offer', '已结束'];

export function JobPage({
  jobId,
  onBack,
  onSelectApplication,
  onSelectJob,
  onUploadStarted,
  refreshNonce = 0,
  fetcher,
}: JobPageProps) {
  const [vm, setVm] = useState<JobCanvasVM | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<JobTab>('pipeline');
  const [stageFilter, setStageFilter] = useState<StageFilter>('全部');

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
    async (cancelledRef?: { current: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        const raw = await fetcher(`/recruitment/api/recruiting/jobs/${encodeURIComponent(jobId)}`);
        if (cancelledRef?.current) return;
        setVm(normalizeJobDetail(raw));
      } catch {
        if (cancelledRef?.current) return;
        setError('暂时没能读取到该岗位的详细资料，请稍后重试。');
      } finally {
        if (!cancelledRef?.current) setLoading(false);
      }
    },
    [jobId, fetcher],
  );

  useEffect(() => {
    const cancelledRef = { current: false };
    void load(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [load, refreshNonce]);

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
    const confirmationText = newJobConfirm.trim();
    if (!title) {
      setFeedback({ tone: 'red', text: '请先填写岗位名称。' });
      return;
    }
    if (!confirmationText) {
      setFeedback({ tone: 'red', text: '请填写确认原话后再创建岗位。' });
      return;
    }
    setCreating(true);
    setFeedback(null);
    try {
      // Strictly NO headcount field per available-actions.md (HC belongs to requisition)
      const res = await postJobCreate({
        title,
        dept: newJobDept.trim() || undefined,
        confirmationText,
      });
      setCreateOpen(false);
      setNewJobTitle('');
      setNewJobDept('');
      setNewJobConfirm('');
      setFeedback({
        tone: 'green',
        text: `已创建岗位「${title}」（标准待审批），可继续完善岗位标准。`,
      });
      if (res.job_id && onSelectJob) {
        onSelectJob(res.job_id);
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
        <div className="ros-head-right">
          <FactLabelsBar labels={vm.factLabels} />
        </div>
      </header>

      <div className="ros-canvas-body">
        <div className="ros-canvas-inner">
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
                      onClick={() => setStageFilter(f)}
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
                  {filteredApps.map((app) => (
                    <div
                      key={app.applicationId}
                      className="ros-clean-row"
                      onClick={() => onSelectApplication?.(app.applicationId)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectApplication?.(app.applicationId);
                        }
                      }}
                    >
                      <div className="ros-cr-left">
                        <span className="ros-mono">{app.candidateName.slice(0, 1)}</span>
                        <span className="ros-cr-name">
                          {app.candidateName}
                          <span className="ros-cr-role">{app.metaText}</span>
                        </span>
                      </div>
                      <StatusLabel text={app.stageLabel} tone={app.statusTone} />
                    </div>
                  ))}
                </div>
              ) : (
                <CanvasEmptyState title="当前阶段暂无候选人" description="切换上方筛选条件可查看其他阶段候选人。" />
              )}
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
