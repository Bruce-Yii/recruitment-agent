import React from 'react';
import type { RecruitingOverviewView } from '../client/recruiting/view-model.ts';
import { prefetchCanvasPath } from '../client/canvas/canvas-ux.ts';
import { fetchAppJson, readCookie } from './api.ts';

export interface JobsViewProps {
  readonly overview: RecruitingOverviewView;
  readonly onOpenJob: (jobId: string) => void;
}

export function JobsView({ overview, onOpenJob }: JobsViewProps) {
  return (
    <div className="canvas-inner" data-testid="app-jobs-view">
      <div className="sec-head">
        <div>
          <h1 className="sec-title">在招岗位</h1>
          <div className="sec-meta">
            共 {overview.counts.jobsTotal} 个岗位，其中 {overview.counts.jobsOpen} 个在招
          </div>
        </div>
      </div>

      {overview.jobs.length === 0 ? (
        <div className="empty-paper">当前暂无在招岗位</div>
      ) : (
        <div className="flow-list">
          {overview.jobs.map((job) => (
            <button
              key={job.id}
              type="button"
              className="flow-row"
              data-testid={`app-job-item-${job.id}`}
              onMouseEnter={() =>
                prefetchCanvasPath(
                  `/recruitment/api/recruiting/jobs/${encodeURIComponent(job.id)}`,
                  (path) => fetchAppJson(path, readCookie('rc_sid')),
                )
              }
              onClick={() => onOpenJob(job.id)}
            >
              <div className="flow-top">
                <span className="flow-job-name">
                  {job.title}
                  {job.departmentName ? (
                    <span className="cr-role" style={{ marginLeft: 8 }}>
                      {job.departmentName}
                    </span>
                  ) : null}
                </span>
                <span className="flow-hc num">
                  在办 {job.applicationCounts.active} / 总计 {job.applicationCounts.total} ·{' '}
                  {job.rubric?.approved ? '评分标准已批准' : '评分标准待确认'}
                </span>
              </div>
              {job.applicationCounts.byStage.length > 0 ? (
                <div className="stage-track">
                  {job.applicationCounts.byStage.map((st) => (
                    <div
                      key={st.code}
                      className={`st-node ${st.count > 0 ? 'active' : ''}`}
                    >
                      <span className="st-dot num">{st.count}</span>
                      <span className="st-lbl">{st.label}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sec-meta">{'点击进入岗位详情与候选人池'}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
