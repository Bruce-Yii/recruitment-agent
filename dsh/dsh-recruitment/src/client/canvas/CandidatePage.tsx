import React, { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeApplicationDetail, type CandidateCanvasVM } from '../normalize-canvas.ts';
import {
  CanvasEmptyState,
  CanvasErrorState,
  CanvasLoadingState,
  FactLabelsBar,
  SequentialRoundRail,
  StatusLabel,
} from './bits/index.ts';
import type { ActiveUploadTask, UndoToastPayload } from './CanvasRoute.tsx';
import {
  postApplicationStar,
  postRebindMinute,
  uploadResumeRaw,
  type CanvasActionError,
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
  onBack?: () => void;
  onOpenJob?: (jobId: string) => void;
  onUploadStarted?: (task: ActiveUploadTask) => void;
  onActionCompleted?: (notice: UndoToastPayload) => void;
  refreshNonce?: number;
  fetcher: CanvasFetcher;
}

type DocTab = 'resume' | 'transcript' | 'original';

export function CandidatePage({
  sessionId,
  applicationId,
  onBack,
  onOpenJob,
  onUploadStarted,
  onActionCompleted,
  refreshNonce = 0,
  fetcher,
}: CandidatePageProps) {
  const [vm, setVm] = useState<CandidateCanvasVM | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCrit, setActiveCrit] = useState('');
  const [docTab, setDocTab] = useState<DocTab>('resume');
  const [expandedTs, setExpandedTs] = useState<number | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const [modalKind, setModalKind] = useState<CandidateModalKind | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [starredLocal, setStarredLocal] = useState(false);
  const [starBusy, setStarBusy] = useState(false);
  const [candUploading, setCandUploading] = useState(false);
  const candFileRef = useRef<HTMLInputElement | null>(null);

  const [pendingRebind, setPendingRebind] = useState<CandidateModalSuccess['rebindPrompt'] | null>(null);
  const [rebindConfirmText, setRebindConfirmText] = useState('');
  const [rebindSubmitting, setRebindSubmitting] = useState(false);

  const load = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        const raw = await fetcher(`/recruitment/api/recruiting/applications/${encodeURIComponent(applicationId)}`);
        if (cancelledRef?.current) return;
        const next = normalizeApplicationDetail(raw);
        setVm(next);
        setStarredLocal(next.starred);
        setActiveCrit(next.criteria[0]?.key || '');
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
  }, [load, refreshNonce]);

  const handleModalSuccess = async (res: CandidateModalSuccess) => {
    setModalKind(null);
    await load();
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
        <div className="ros-canvas-body"><div className="ros-canvas-inner"><CanvasLoadingState label="正在读取候选人档案与评估依据…" /></div></div>
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
        <div className="ros-head-right"><FactLabelsBar labels={vm.factLabels} /></div>
      </header>

      <div className="ros-canvas-body">
        <div className="ros-canvas-inner ros-doc">
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

          <div className="ros-doc-head">
            <div>
              <div className="ros-doc-name">{vm.candidateName}</div>
              <div className="ros-doc-meta">
                {vm.jobTitle}（{vm.jobCode}）· 档案号 <span className="num">{vm.shortRef}</span> · 标准 {vm.rubricVersionLabel}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  data-testid="canvas-action-star"
                  disabled={starBusy}
                  title={starredLocal ? '取消星标主推' : '设为星标主推'}
                  style={{ fontSize: '16px', color: starredLocal ? 'var(--amber)' : 'var(--soft)' }}
                  onClick={() => {
                    if (starBusy) return;
                    setStarBusy(true);
                    void postApplicationStar({ applicationId: vm.applicationId, starred: !starredLocal })
                      .then((res) => {
                        setStarredLocal(Boolean(res.starred));
                        setActionFeedback({ tone: 'green', text: res.starred ? '已标记为主推候选人' : '已取消星标标记' });
                      })
                      .catch((err) => setActionFeedback({ tone: 'red', text: (err as CanvasActionError)?.userMessage || '星标更新失败' }))
                      .finally(() => setStarBusy(false));
                  }}
                >
                  {starredLocal ? '★' : '☆'}
                </button>
                <StatusLabel text={vm.stageLabel} tone={vm.isArchived ? '' : 'iris'} />
              </div>
              <span className="ros-sec-meta">{vm.lifecycleLabel}</span>
            </div>
          </div>

          {vm.stageBlockedReason ? <div className="ros-risk-note">{vm.stageBlockedReason}</div> : null}

          <div className="ros-doc-block">
            <div className="ros-sec-meta">当前状态与提炼</div>
            <div style={{ fontSize: '14.5px', lineHeight: 1.78, color: 'var(--ink)' }}>{vm.summaryText}</div>
          </div>

          <div className="ros-doc-block">
            <div className="ros-sec-meta">岗位标准对照 · {vm.rubricVersionLabel}（点击联动原文）</div>
            {vm.criteria.length > 0 ? (
              <div>
                {vm.criteria.map((cr, idx) => (
                  <div key={cr.key} className={`ros-crit-item ${cr.key === activeCrit ? 'active' : ''}`} onClick={() => setActiveCrit(cr.key)} role="button" tabIndex={0}>
                    <span style={{ fontSize: '13.5px', fontWeight: 500 }}>
                      <span className="num" style={{ color: 'var(--soft)', marginRight: 8 }}>0{idx + 1}</span>
                      {cr.label}
                      <span className="ros-sec-meta" style={{ marginLeft: 8 }}>{cr.kindLabel}{cr.weightText ? ` · ${cr.weightText}` : ''}</span>
                    </span>
                    <StatusLabel text={cr.statusText} tone={cr.level} />
                  </div>
                ))}
              </div>
            ) : <CanvasEmptyState title="暂无岗位标准维度" />}
          </div>

          <div className="ros-doc-block">
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

          <div className="ros-doc-block">
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
                          <div key={it.id} className={`ros-doc-line ${it.matchKey === activeCrit ? 'active' : ''}`} onClick={() => setActiveCrit(it.matchKey)}>
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
