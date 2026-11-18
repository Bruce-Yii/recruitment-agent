import React from 'react';
import { CandidatePage, type CanvasFetcher } from './CandidatePage';
import { JobPage } from './JobPage';
import { CanvasEmptyState } from './bits';
import { CANVAS_CSS } from './canvas-styles.ts';

export type CanvasRouteTarget =
  | { kind: 'empty' }
  | { kind: 'candidate'; applicationId: string }
  | { kind: 'job'; jobId: string };

export interface CanvasRouteProps {
  route: CanvasRouteTarget;
  onBack?: () => void;
  onSelectApplication?: (applicationId: string) => void;
  onSelectJob?: (jobId: string) => void;
  /** Optional custom fetcher for tests; defaults to host same-origin HTTP fetch. */
  fetcher?: CanvasFetcher;
}

/**
 * Default host HTTP fetcher per client-plugin-contract.md §2:
 * - Same-origin cookie determines actor (frontend never sends actor)
 * - Always carries `x-recruitment-request: 1`
 */
export async function fetchCanvasJson(path: string): Promise<unknown> {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      'x-recruitment-request': '1',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error('CANVAS_FETCH_FAILED');
  }
  return res.json();
}

export function CanvasRoute({
  route,
  onBack,
  onSelectApplication,
  onSelectJob,
  fetcher = fetchCanvasJson,
}: CanvasRouteProps) {
  return (
    <section className="ros-canvas" aria-label="招聘详情画布">
      <style>{CANVAS_CSS}</style>
      {route.kind === 'candidate' ? (
        <CandidatePage
          applicationId={route.applicationId}
          onBack={onBack}
          onOpenJob={onSelectJob}
          fetcher={fetcher}
        />
      ) : route.kind === 'job' ? (
        <JobPage
          jobId={route.jobId}
          onBack={onBack}
          onSelectApplication={onSelectApplication}
          fetcher={fetcher}
        />
      ) : (
        <div className="ros-canvas-body">
          <div className="ros-canvas-inner">
            <CanvasEmptyState
              title="选择一条记录查看详情"
              description="从左侧工作台列表点击任意候选人或岗位，右侧画布将立即展开完整档案与进度。"
            />
          </div>
        </div>
      )}
    </section>
  );
}

export default CanvasRoute;
