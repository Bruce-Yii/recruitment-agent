import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ApplicationRowView, RecruitingOverviewView } from '../client/recruiting/view-model.ts';
import { prefetchCanvasPath } from '../client/canvas/canvas-ux.ts';
import { uploadResumeRaw } from '../client/canvas/canvas-actions.ts';
import type { ActiveUploadTask } from '../client/canvas/CanvasRoute.tsx';
import { fetchAppJson, readCookie } from './api.ts';

export interface QueueFilterRequest {
  readonly filter: 'all' | 'screening' | 'interviewing';
  readonly nonce: number;
}

export interface QueueViewProps {
  readonly overview: RecruitingOverviewView;
  readonly filterRequest?: QueueFilterRequest | null;
  readonly onFilterConsumed?: () => void;
  readonly onOpenApplication: (applicationId: string, queue: string[]) => void;
  readonly onUploadStarted: (task: ActiveUploadTask) => void;
}

function statusClass(tone: string): string {
  if (tone === 'danger' || tone === 'warn' || tone === 'info' || tone === 'ok') {
    return tone;
  }
  return '';
}

function cleanStageLabel(raw: string): string {
  const parts = raw.split('/');
  return (parts[0] ?? raw).trim() || raw;
}

function deriveRowUrgency(
  app: ApplicationRowView,
  evaluatedAtMs: number,
): { readonly label: string; readonly toneClass: string } {
  const baseLabel = cleanStageLabel(app.stageLabel);
  const overdueScorecards = app.interviews.reduce(
    (sum, iv) => sum + (iv.scorecards?.overdue ?? 0),
    0,
  );
  const enteredRaw = app.stageEnteredAt || app.appliedAt;
  const enteredMs = enteredRaw ? Date.parse(enteredRaw) : Number.NaN;
  const elapsedHours =
    Number.isFinite(enteredMs) && evaluatedAtMs > enteredMs
      ? Math.floor((evaluatedAtMs - enteredMs) / 3_600_000)
      : 0;

  if (app.filterKind === 'screening' && elapsedHours >= 24) {
    return { label: `初筛 · ${elapsedHours}h 超时`, toneClass: 'danger' };
  }
  if (overdueScorecards > 0) {
    return {
      label: `${baseLabel} · 面评超时 ${overdueScorecards} 份`,
      toneClass: 'danger',
    };
  }
  return { label: baseLabel, toneClass: statusClass(app.stageTone) };
}

function buildRowReason(app: ApplicationRowView): string {
  const parts: string[] = [];
  if (app.stageBlockedReason) {
    parts.push(app.stageBlockedReason);
  } else if (app.nextStep.hasStep && app.nextStep.label) {
    parts.push(app.nextStep.label);
  }
  const fact = app.interviewSummary || app.screeningSummary || app.materialSummary;
  if (fact && !parts.some((p) => p.includes(fact))) {
    parts.push(fact);
  }
  return parts.join(' · ');
}

export function QueueView({
  overview,
  filterRequest,
  onFilterConsumed,
  onOpenApplication,
  onUploadStarted,
}: QueueViewProps) {
  const [stageFilter, setStageFilter] = useState<string>('all');
  const lastFilterNonceRef = useRef<number>(0);

  useEffect(() => {
    if (!filterRequest || filterRequest.nonce === lastFilterNonceRef.current) return;
    lastFilterNonceRef.current = filterRequest.nonce;
    setStageFilter(filterRequest.filter);
    onFilterConsumed?.();
  }, [filterRequest, onFilterConsumed]);
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return overview.applications.filter((app) => {
      if (stageFilter === 'screening' && app.filterKind !== 'screening') return false;
      if (stageFilter === 'interviewing' && app.filterKind !== 'interviewing') return false;
      if (stageFilter === 'other' && app.filterKind !== 'other') return false;
      if (
        stageFilter !== 'all' &&
        stageFilter !== 'screening' &&
        stageFilter !== 'interviewing' &&
        stageFilter !== 'other' &&
        app.stageCode !== stageFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        app.candidateName.toLowerCase().includes(q) ||
        app.jobTitle.toLowerCase().includes(q) ||
        app.stageLabel.toLowerCase().includes(q)
      );
    });
  }, [overview.applications, stageFilter, query]);

  const queueIds = useMemo(() => filtered.map((a) => a.id), [filtered]);
  const defaultJobId = overview.jobs[0]?.id ?? '';
  const evaluatedAtMs = useMemo(() => {
    const parsed = overview.evaluatedAt ? Date.parse(overview.evaluatedAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
  }, [overview.evaluatedAt]);

  const handleRowHover = (app: ApplicationRowView) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      prefetchCanvasPath(
        `/recruitment/api/recruiting/applications/${encodeURIComponent(app.id)}`,
        (path) => fetchAppJson(path, readCookie('rc_sid')),
      );
    }, 120);
  };

  const handleRowLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleUploadFile = async (file: File) => {
    if (!defaultJobId) {
      setUploadError('当前没有在招岗位，无法上传简历。');
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const started = await uploadResumeRaw(file, defaultJobId);
      onUploadStarted({ taskId: started.taskId, fileName: file.name });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '简历上传失败，请重试。');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="canvas-inner" data-testid="app-queue-view">
      <div>
        <div className="sec-head" style={{ marginBottom: 18 }}>
          <div>
            <div className="sec-title">待推进候选人</div>
            <div className="editorial-stats num">
              <span>在办 <strong>{overview.counts.applicationsActive}</strong></span>
              <span className="dot">·</span>
              <span>待初筛 <strong>{overview.counts.awaitingScreening}</strong></span>
              <span className="dot">·</span>
              <span>面试中 <strong>{overview.counts.interviewing}</strong></span>
              <span className="dot">·</span>
              <span>待决策 <strong>{overview.counts.awaitingDecision}</strong></span>
            </div>
          </div>
          {defaultJobId ? (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.doc,.docx,.txt"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleUploadFile(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="btn dark"
                disabled={uploading}
                data-testid="app-action-upload"
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? '上传中…' : '导入简历'}
              </button>
            </div>
          ) : null}
        </div>

        {uploadError ? (
          <div className="offline-banner" style={{ marginBottom: 14 }}>
            <span>{uploadError}</span>
          </div>
        ) : null}

        <div className="filter-bar" style={{ marginBottom: 14 }}>
          <div className="filter-pills">
            <button
              type="button"
              className={`f-pill ${stageFilter === 'all' ? 'active' : ''}`}
              data-testid="app-queue-filter-all"
              onClick={() => setStageFilter('all')}
            >
              全部 ({overview.applications.length})
            </button>
            <button
              type="button"
              className={`f-pill ${stageFilter === 'screening' ? 'active' : ''}`}
              data-testid="app-queue-filter-screening"
              onClick={() => setStageFilter('screening')}
            >
              待初筛 ({overview.counts.awaitingScreening})
            </button>
            <button
              type="button"
              className={`f-pill ${stageFilter === 'interviewing' ? 'active' : ''}`}
              data-testid="app-queue-filter-interviewing"
              onClick={() => setStageFilter('interviewing')}
            >
              面试中 ({overview.counts.interviewing})
            </button>
            {overview.counts.byStage.map((st) => (
              <button
                key={st.code}
                type="button"
                className={`f-pill ${stageFilter === st.code ? 'active' : ''}`}
                data-testid={`app-queue-filter-${st.code}`}
                onClick={() => setStageFilter(st.code)}
              >
                {cleanStageLabel(st.label)} ({st.count})
              </button>
            ))}
          </div>
          <input
            className="clean-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索姓名、岗位或阶段…"
            data-testid="app-queue-search"
          />
        </div>

        {filtered.length === 0 ? (
          <div className="empty-paper">
            <div>当前筛选下暂无候选人</div>
          </div>
        ) : (
          <div className="clean-list">
            {filtered.map((app) => {
              const urgency = deriveRowUrgency(app, evaluatedAtMs);
              const reasonText = buildRowReason(app);
              return (
                <button
                  key={app.id}
                  type="button"
                  className="clean-row"
                  data-testid={`app-queue-item-${app.id}`}
                  onMouseEnter={() => handleRowHover(app)}
                  onMouseLeave={handleRowLeave}
                  onClick={() => onOpenApplication(app.id, queueIds)}
                >
                  <div className="cr-left">
                    <span className="mono">{app.candidateInitial || app.candidateName.slice(0, 1)}</span>
                    <div className="cr-text">
                      <div className="cr-title-line">
                        <span className="cr-name">{app.candidateName}</span>
                        <span className="cr-role">{app.jobTitle}</span>
                      </div>
                      {reasonText ? <div className="cr-sub">{reasonText}</div> : null}
                    </div>
                  </div>
                  <div className="cr-right">
                    <span className={`cr-status num ${urgency.toneClass}`}>
                      {urgency.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
