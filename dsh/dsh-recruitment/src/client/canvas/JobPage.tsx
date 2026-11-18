import React, { useCallback, useEffect, useState } from 'react';
import {
  normalizeJobDetail,
  type JobApplicationRowVM,
  type JobCanvasVM,
} from '../normalize-canvas';
import {
  CanvasEmptyState,
  CanvasErrorState,
  CanvasLoadingState,
  FactLabelsBar,
  StageTrack,
  StatusLabel,
} from './bits';
import type { CanvasFetcher } from './CandidatePage';

export interface JobPageProps {
  jobId: string;
  onBack?: () => void;
  onSelectApplication?: (applicationId: string) => void;
  fetcher: CanvasFetcher;
}

type JobTab = 'pipeline' | 'rubric';
type StageFilter = '全部' | JobApplicationRowVM['filterBucket'];

const STAGE_FILTERS: StageFilter[] = ['全部', '接入', '初筛', '面试中', '终审与 Offer', '已结束'];

export function JobPage({
  jobId,
  onBack,
  onSelectApplication,
  fetcher,
}: JobPageProps) {
  const [vm, setVm] = useState<JobCanvasVM | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<JobTab>('pipeline');
  const [stageFilter, setStageFilter] = useState<StageFilter>('全部');

  const load = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        const raw = await fetcher(`/recruitment/api/recruiting/jobs/${encodeURIComponent(jobId)}`);
        if (cancelledRef?.current) return;
        setVm(normalizeJobDetail(raw));
        setTab('pipeline');
        setStageFilter('全部');
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
  }, [load]);

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
                <span className="ros-sec-meta num">{filteredApps.length} 人</span>
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
    </>
  );
}
