import React, { useCallback, useEffect, useState } from 'react';
import { CandidatePage, type CanvasFetcher } from './CandidatePage';
import { JobPage } from './JobPage';
import { CanvasEmptyState } from './bits';
import { fetchTaskStatus, type UploadTaskStatusResult } from './canvas-actions';
import { CANVAS_CSS } from './canvas-styles.ts';

export type CanvasRouteTarget =
  | { kind: 'empty' }
  | { kind: 'candidate'; applicationId: string }
  | { kind: 'job'; jobId: string };

export interface ActiveUploadTask {
  taskId: string;
  fileName: string;
}

export interface CanvasRouteProps {
  route: CanvasRouteTarget;
  onBack?: () => void;
  onSelectApplication?: (applicationId: string) => void;
  onSelectJob?: (jobId: string) => void;
  /** Active async resume upload task to poll in top non-blocking banner (T3-3). */
  uploadTask?: ActiveUploadTask | null;
  onDismissUploadTask?: () => void;
  onUploadCompleted?: (result: UploadTaskStatusResult) => void;
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

/**
 * T3-3: Non-blocking upload progress & failure banner.
 * Polls GET /recruitment/api/tasks/status?task_id=... until terminal state.
 * Never claims "已入库" before COMPLETED; displays human errorSummary on FAILED.
 */
function UploadProgressBanner({
  task,
  onOpenApplication,
  onDismiss,
  onCompleted,
}: {
  task: ActiveUploadTask;
  onOpenApplication?: (applicationId: string) => void;
  onDismiss?: () => void;
  onCompleted?: (result: UploadTaskStatusResult) => void;
}) {
  const [state, setState] = useState<UploadTaskStatusResult>({
    taskId: task.taskId,
    status: 'RUNNING',
  });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetchTaskStatus(task.taskId);
        if (!active) return;
        setState(res);
        if (res.status === 'RUNNING') {
          timer = setTimeout(poll, 1500);
        } else if (res.status === 'COMPLETED') {
          onCompleted?.(res);
        }
      } catch {
        if (!active) return;
        setState({
          taskId: task.taskId,
          status: 'FAILED',
          errorSummary: '暂时无法获取解析结果，请稍后刷新列表确认',
        });
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [task.taskId, onCompleted]);

  if (state.status === 'RUNNING') {
    return (
      <div
        role="status"
        style={{
          margin: '12px 36px 0',
          padding: '10px 14px',
          borderRadius: 10,
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '12.5px',
          color: 'var(--text)',
        }}
      >
        <span className="ros-thinking-row">
          <i className="ros-thinking-dot" />
          <span>正在解析「{task.fileName}」，完成后会自动提示（你可继续浏览当前页面）…</span>
        </span>
      </div>
    );
  }

  if (state.status === 'FAILED') {
    return (
      <div
        role="alert"
        style={{
          margin: '12px 36px 0',
          padding: '10px 14px',
          borderRadius: 10,
          background: 'var(--red-soft)',
          color: 'var(--red)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          fontSize: '12.5px',
        }}
      >
        <span>解析未完成（{task.fileName}）：{state.errorSummary || '请检查文件后重试'}</span>
        {onDismiss ? (
          <button type="button" className="ros-text-link" style={{ color: 'var(--red)' }} onClick={onDismiss}>
            关闭
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="status"
      style={{
        margin: '12px 36px 0',
        padding: '10px 14px',
        borderRadius: 10,
        background: 'var(--green-soft)',
        color: 'var(--green)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: '12.5px',
      }}
    >
      <span>
        ✓ 解析完成：{state.candidateName ? `${state.candidateName} 已入库` : `「${task.fileName}」已入库`}
      </span>
      <div style={{ display: 'flex', gap: 10 }}>
        {state.applicationId && onOpenApplication ? (
          <button
            type="button"
            className="ros-text-link"
            style={{ color: 'var(--green)', fontWeight: 600 }}
            onClick={() => onOpenApplication(state.applicationId!)}
          >
            查看档案
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="ros-text-link" onClick={onDismiss}>
            关闭
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function CanvasRoute({
  route,
  onBack,
  onSelectApplication,
  onSelectJob,
  uploadTask,
  onDismissUploadTask,
  onUploadCompleted,
  fetcher = fetchCanvasJson,
}: CanvasRouteProps) {
  return (
    <section className="ros-canvas" aria-label="招聘详情画布">
      <style>{CANVAS_CSS}</style>
      {uploadTask ? (
        <UploadProgressBanner
          task={uploadTask}
          onOpenApplication={onSelectApplication}
          onDismiss={onDismissUploadTask}
          onCompleted={onUploadCompleted}
        />
      ) : null}
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

/**
 * §4 Non-hash state-driven host wrapper:
 * DSH shell owns `location.hash`; NEVER mutate `location.hash` to open the canvas.
 * Use this state-only controller inside RecruitingWorkspace / Workbench:
 * when a row is clicked, switch React state to open CanvasRoute; clicking Back returns to list.
 */
export interface CanvasPanelHostProps {
  children: (controls: {
    openCandidate: (applicationId: string) => void;
    openJob: (jobId: string) => void;
    closeCanvas: () => void;
    activeRoute: CanvasRouteTarget;
  }) => React.ReactNode;
  fetcher?: CanvasFetcher;
}

export function CanvasPanelHost({ children, fetcher }: CanvasPanelHostProps) {
  const [route, setRoute] = useState<CanvasRouteTarget>({ kind: 'empty' });
  const [prevJobId, setPrevJobId] = useState<string | null>(null);

  const openCandidate = useCallback((applicationId: string) => {
    setRoute({ kind: 'candidate', applicationId });
  }, []);

  const openJob = useCallback((jobId: string) => {
    setPrevJobId(jobId);
    setRoute({ kind: 'job', jobId });
  }, []);

  const handleBack = useCallback(() => {
    if (route.kind === 'candidate' && prevJobId) {
      setRoute({ kind: 'job', jobId: prevJobId });
      return;
    }
    setPrevJobId(null);
    setRoute({ kind: 'empty' });
  }, [route.kind, prevJobId]);

  if (route.kind !== 'empty') {
    return (
      <CanvasRoute
        route={route}
        onBack={handleBack}
        onSelectApplication={openCandidate}
        onSelectJob={openJob}
        fetcher={fetcher}
      />
    );
  }

  return <>{children({ openCandidate, openJob, closeCanvas: handleBack, activeRoute: route })}</>;
}

export default CanvasRoute;
