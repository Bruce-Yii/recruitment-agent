import React, { useCallback, useEffect, useState } from 'react';
import {
  normalizeApplicationDetail,
  type CandidateCanvasVM,
} from '../normalize-canvas';
import {
  CanvasEmptyState,
  CanvasErrorState,
  CanvasLoadingState,
  FactLabelsBar,
  SequentialRoundRail,
  StatusLabel,
} from './bits';

export type CanvasFetcher = (path: string) => Promise<unknown>;

export interface CandidatePageProps {
  applicationId: string;
  onBack?: () => void;
  onOpenJob?: (jobId: string) => void;
  fetcher: CanvasFetcher;
}

type DocTab = 'resume' | 'transcript' | 'original';

export function CandidatePage({
  applicationId,
  onBack,
  onOpenJob,
  fetcher,
}: CandidatePageProps) {
  const [vm, setVm] = useState<CandidateCanvasVM | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCrit, setActiveCrit] = useState<string>('');
  const [docTab, setDocTab] = useState<DocTab>('resume');
  const [expandedTs, setExpandedTs] = useState<number | null>(null);
  const [timelineOpen, setTimelineOpen] = useState<boolean>(false);

  const load = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        const raw = await fetcher(
          `/recruitment/api/recruiting/applications/${encodeURIComponent(applicationId)}`,
        );
        if (cancelledRef?.current) return;
        const next = normalizeApplicationDetail(raw);
        setVm(next);
        setActiveCrit(next.criteria[0]?.key || '');
        setDocTab('resume');
        setExpandedTs(null);
        setTimelineOpen(false);
      } catch {
        if (cancelledRef?.current) return;
        setError('暂时没能读取到这位候选人的档案，请稍后重试。');
      } finally {
        if (!cancelledRef?.current) setLoading(false);
      }
    },
    [applicationId, fetcher],
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
            <span className="ros-crumb-cur">候选人档案</span>
          </div>
        </header>
        <div className="ros-canvas-body">
          <div className="ros-canvas-inner">
            <CanvasLoadingState label="正在读取候选人档案与评估依据…" />
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
            <span className="ros-crumb-cur">候选人档案</span>
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

  let lineNo = 0;

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
            {onOpenJob && vm.jobId ? (
              <button
                type="button"
                className="ros-crumb-link"
                onClick={() => onOpenJob(vm.jobId)}
              >
                {vm.jobTitle}
              </button>
            ) : (
              <span>{vm.jobTitle}</span>
            )}
            <span>/</span>
            <span>{vm.stageLabel}</span>
            <span>/</span>
            <span className="ros-crumb-cur">{vm.candidateName}</span>
          </div>
        </div>
        <div className="ros-head-right">
          <FactLabelsBar labels={vm.factLabels} />
        </div>
      </header>

      <div className="ros-canvas-body">
        <div className="ros-canvas-inner">
          {/* 1. 档案头 */}
          <div className="ros-doc-head">
            <div>
              <div className="ros-doc-name">{vm.candidateName}</div>
              <div className="ros-doc-meta">
                {vm.jobTitle}（{vm.jobCode}）· 档案号 <span className="num">{vm.shortRef}</span> · 标准{' '}
                {vm.rubricVersionLabel}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <StatusLabel text={vm.stageLabel} tone={vm.isArchived ? '' : 'iris'} />
              <span className="ros-sec-meta">{vm.lifecycleLabel}</span>
            </div>
          </div>

          {vm.stageBlockedReason ? (
            <div className="ros-risk-note">{vm.stageBlockedReason}</div>
          ) : null}

          {/* 2. 核心提炼与下一步 */}
          <div className="ros-doc-block">
            <div className="ros-sec-meta">当前状态与提炼</div>
            <div style={{ fontSize: '14.5px', lineHeight: 1.78, color: 'var(--ink)' }}>
              {vm.summaryText}
            </div>
          </div>

          {/* 3. 岗位标准逐条对照（绿/黄/红，点击联动高亮简历） */}
          <div className="ros-doc-block">
            <div className="ros-sec-meta">
              岗位标准对照 · {vm.rubricVersionLabel}（点击联动原文）
            </div>
            {vm.criteria.length > 0 ? (
              <div>
                {vm.criteria.map((cr, idx) => (
                  <div
                    key={cr.key}
                    className={`ros-crit-item ${cr.key === activeCrit ? 'active' : ''}`}
                    onClick={() => setActiveCrit(cr.key)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveCrit(cr.key);
                      }
                    }}
                  >
                    <span style={{ fontSize: '13.5px', fontWeight: 500 }}>
                      <span className="num" style={{ color: 'var(--soft)', marginRight: 8 }}>
                        0{idx + 1}
                      </span>
                      {cr.label}
                      <span className="ros-sec-meta" style={{ marginLeft: 8 }}>
                        {cr.kindLabel}
                        {cr.weightText ? ` · ${cr.weightText}` : ''}
                      </span>
                    </span>
                    <StatusLabel text={cr.statusText} tone={cr.level} />
                  </div>
                ))}
              </div>
            ) : (
              <CanvasEmptyState title="暂无岗位标准维度" description="该岗位尚未配置或锁定考核标准。" />
            )}
          </div>

          {/* 4. 逐轮面试进展（独立呈现，严禁求平均分） */}
          <div className="ros-doc-block">
            <div className="ros-sec-meta">逐轮面试进展（不求平均分）</div>
            {vm.rounds.length > 0 ? (
              <>
                <SequentialRoundRail rounds={vm.rounds} />
                <div className="ros-clean-list" style={{ borderTop: 0 }}>
                  {vm.rounds.map((rd) => (
                    <div key={rd.id} className="ros-clean-row static">
                      <div>
                        <div style={{ fontSize: '13.5px', fontWeight: 600 }}>
                          {rd.roundLabel}
                          <span className="ros-sec-meta num" style={{ marginLeft: 8 }}>
                            {rd.scheduleText}
                          </span>
                        </div>
                        <div style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: 2 }}>
                          {rd.detailText} · {rd.scorecardsSummary} · {rd.transcriptStateLabel}
                          {rd.overdueCount > 0 ? ` · ${rd.overdueCount} 份面评已超时` : ''}
                        </div>
                      </div>
                      <StatusLabel
                        text={rd.statusText}
                        tone={rd.statusTone === 'done' ? 'green' : rd.statusTone === 'caution' ? 'amber' : 'iris'}
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <CanvasEmptyState title="尚未安排面试" description="当前还没有进入面试轮次。" />
            )}
          </div>

          {/* 5. 简历分段原位高亮 / 飞书妙记 / 原件预览 */}
          <div className="ros-doc-block">
            <div style={{ display: 'flex', gap: 16 }}>
              <button
                type="button"
                className={`ros-text-link ${docTab === 'resume' ? 'active' : ''}`}
                onClick={() => setDocTab('resume')}
              >
                简历原文
              </button>
              <button
                type="button"
                className={`ros-text-link ${docTab === 'transcript' ? 'active' : ''}`}
                onClick={() => setDocTab('transcript')}
              >
                飞书妙记
              </button>
              <button
                type="button"
                className={`ros-text-link ${docTab === 'original' ? 'active' : ''}`}
                onClick={() => setDocTab('original')}
              >
                原件预览
              </button>
            </div>

            {docTab === 'resume' ? (
              vm.hasResumeMaterial && vm.resumeSections.length > 0 ? (
                <div>
                  {vm.resumeSections.map((sec) => (
                    <div key={sec.title}>
                      <div className="ros-resume-group">{sec.title}</div>
                      {sec.items.map((it) => {
                        lineNo += 1;
                        const noStr = lineNo < 10 ? `0${lineNo}` : String(lineNo);
                        return (
                          <div
                            key={it.id}
                            className={`ros-doc-line ${it.matchKey === activeCrit ? 'active' : ''}`}
                            onClick={() => setActiveCrit(it.matchKey)}
                          >
                            <span className="ros-doc-no num">{noStr}</span>
                            <div>
                              {it.heading || it.period || it.pageLabel ? (
                                <div className="ros-exp-meta">
                                  <span className="ros-exp-co">{it.heading || ''}</span>
                                  <span className="ros-exp-time num">
                                    {it.period || it.pageLabel || ''}
                                  </span>
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
              ) : (
                <CanvasEmptyState title="还没有简历原件" description="当前申请尚未上传或解析出简历内容。" />
              )
            ) : docTab === 'transcript' ? (
              vm.hasTranscript ? (
                <div>
                  {vm.transcriptItems.map((tr, idx) => (
                    <div
                      key={tr.id}
                      className={`ros-doc-line ${tr.matchKey === activeCrit ? 'active' : ''}`}
                      onClick={() => setExpandedTs(expandedTs === idx ? null : idx)}
                    >
                      <span className="ros-doc-no num">0{idx + 1}</span>
                      <div>
                        <div>
                          {tr.timestamp ? <span className="ros-ts-badge num">{tr.timestamp}</span> : null}
                          {tr.summary}
                        </div>
                        {tr.context && expandedTs === idx ? (
                          <div className="ros-jd-box" style={{ marginTop: 8, padding: '10px 12px' }}>
                            {tr.context}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <CanvasEmptyState title="还没有转录" description="面试完成后将自动同步飞书妙记录音转写。" />
              )
            ) : vm.hasResumeMaterial && vm.materialContentUrl ? (
              <div className="ros-jd-box">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span>{vm.materialFileName || '简历原件'}</span>
                  <a
                    href={vm.materialContentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ros-text-link active"
                  >
                    在新标签页查看原件 ↗
                  </a>
                </div>
              </div>
            ) : (
              <CanvasEmptyState title="还没有简历原件" description="当前申请尚未关联可预览的二进制原件。" />
            )}
          </div>

          {/* 6. 初筛依据 */}
          {vm.screeningBasis.length > 0 ? (
            <div className="ros-doc-block">
              <div className="ros-sec-meta">初筛依据</div>
              <div className="ros-clean-list">
                {vm.screeningBasis.map((b, idx) => (
                  <div key={`${b.label}-${idx}`} className="ros-clean-row static">
                    <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}>{b.label}</span>
                    <span style={{ fontSize: '12.5px', color: 'var(--muted)' }}>{b.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* 7. 不可执行动作原因透明提示（不新增按钮，仅按契约说明原因） */}
          {vm.unavailableActions.length > 0 ? (
            <div className="ros-risk-note">
              {vm.unavailableActions.map((act) => (
                <div key={act.key}>
                  「{act.label}」暂不可执行：{act.reason || '当前阶段或条件尚未满足'}
                </div>
              ))}
            </div>
          ) : null}

          {/* 8. 全链路动态留痕 */}
          <div>
            <div
              className="ros-auto-toggle"
              onClick={() => setTimelineOpen((v) => !v)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setTimelineOpen((v) => !v);
                }
              }}
            >
              <span>全链路动态留痕（{vm.timeline.length}）</span>
              <span>{timelineOpen ? '收起 ▴' : '展开 ▾'}</span>
            </div>
            {timelineOpen ? (
              vm.timeline.length > 0 ? (
                <div className="ros-clean-list">
                  {vm.timeline.map((ev) => (
                    <div key={ev.id} className="ros-clean-row static" style={{ padding: '9px 4px' }}>
                      <span style={{ fontSize: '12.5px', color: 'var(--text)' }}>{ev.label}</span>
                      <span className="ros-sec-meta num">{ev.timeText}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <CanvasEmptyState title="暂无动态留痕" />
              )
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
