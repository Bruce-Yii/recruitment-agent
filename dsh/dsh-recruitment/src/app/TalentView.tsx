import React, { useMemo, useState } from 'react';
import type { RecruitingOverviewView } from '../client/recruiting/view-model.ts';
import { prefetchCanvasPath } from '../client/canvas/canvas-ux.ts';
import { fetchAppJson, readCookie } from './api.ts';

export interface TalentViewProps {
  readonly overview: RecruitingOverviewView;
  readonly onOpenApplication: (applicationId: string, queue: string[]) => void;
}

function cleanStageLabel(raw: string): string {
  const parts = raw.split('/');
  return (parts[0] ?? raw).trim() || raw;
}

function statusClass(tone: string): string {
  if (tone === 'danger' || tone === 'warn' || tone === 'info' || tone === 'ok') {
    return tone;
  }
  return '';
}

export function TalentView({ overview, onOpenApplication }: TalentViewProps) {
  const [query, setQuery] = useState('');
  const [jobFilter, setJobFilter] = useState('all');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return overview.applications.filter((app) => {
      if (jobFilter !== 'all' && app.jobId !== jobFilter) return false;
      if (!q) return true;
      return (
        app.candidateName.toLowerCase().includes(q) ||
        app.jobTitle.toLowerCase().includes(q) ||
        app.stageLabel.toLowerCase().includes(q)
      );
    });
  }, [overview.applications, query, jobFilter]);

  const ids = useMemo(() => list.map((a) => a.id), [list]);

  return (
    <div className="canvas-inner" data-testid="app-talent-view">
      <div className="sec-head">
        <div>
          <h1 className="sec-title">人才库</h1>
          <div className="sec-meta">跨岗位检索全部候选人档案（共 {overview.applications.length} 位）</div>
        </div>
        <input
          className="clean-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索候选人姓名或岗位…"
          data-testid="app-talent-search"
        />
      </div>

      <div className="filter-pills">
        <button
          type="button"
          className={`f-pill ${jobFilter === 'all' ? 'active' : ''}`}
          onClick={() => setJobFilter('all')}
        >
          全部岗位
        </button>
        {overview.jobs.map((job) => (
          <button
            key={job.id}
            type="button"
            className={`f-pill ${jobFilter === job.id ? 'active' : ''}`}
            onClick={() => setJobFilter(job.id)}
          >
            {job.title}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="empty-paper">没有匹配的候选人档案</div>
      ) : (
        <div className="clean-list">
          {list.map((app) => (
            <button
              key={app.id}
              type="button"
              className="clean-row"
              data-testid={`app-talent-item-${app.id}`}
              onMouseEnter={() =>
                prefetchCanvasPath(
                  `/recruitment/api/recruiting/applications/${encodeURIComponent(app.id)}`,
                  (path) => fetchAppJson(path, readCookie('rc_sid')),
                )
              }
              onClick={() => onOpenApplication(app.id, ids)}
            >
              <div className="cr-left">
                <span className="mono">{app.candidateInitial || app.candidateName.slice(0, 1)}</span>
                <div className="cr-text">
                  <div className="cr-title-line">
                    <span className="cr-name">{app.candidateName}</span>
                    <span className="cr-role">{app.jobTitle}</span>
                  </div>
                  <div className="cr-sub">
                    {app.lifecycleLabel} · 投递于 {app.appliedAtText || '近期'}
                  </div>
                </div>
              </div>
              <div className="cr-right">
                <span className={`cr-status ${statusClass(app.stageTone)}`}>
                  {cleanStageLabel(app.stageLabel)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
