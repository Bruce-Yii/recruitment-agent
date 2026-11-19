import React, { useCallback, useEffect, useState } from 'react';
import { CandidatePage, type CanvasFetcher } from './CandidatePage.tsx';
import { JobPage } from './JobPage.tsx';
import { CanvasEmptyState } from './bits/index.ts';
import {
  fetchTaskStatus,
  postActionUndo,
  setCanvasSessionId,
  postSettingsWrite,
  type CanvasActionError,
  type UploadTaskStatusResult,
} from './canvas-actions.ts';
import './canvas.css';

export type CanvasRouteTarget =
  | { kind: 'empty' }
  | { kind: 'candidate'; applicationId: string }
  | { kind: 'job'; jobId: string };

export interface ActiveUploadTask {
  taskId: string;
  fileName: string;
}

export interface UndoToastPayload {
  message: string;
  actionId?: string;
}

export interface CanvasRouteProps {
  route: CanvasRouteTarget;
  onBack?: () => void;
  onSelectApplication?: (applicationId: string) => void;
  onSelectJob?: (jobId: string) => void;
  uploadTask?: ActiveUploadTask | null;
  onUploadStarted?: (task: ActiveUploadTask) => void;
  onDismissUploadTask?: () => void;
  onUploadCompleted?: (result: UploadTaskStatusResult) => void;
  onActionCompleted?: (notice: UndoToastPayload) => void;
  refreshNonce?: number;
  fetcher?: CanvasFetcher;
}

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
  onUploadStarted,
  onDismissUploadTask,
  onUploadCompleted,
  onActionCompleted,
  refreshNonce = 0,
  fetcher = fetchCanvasJson,
}: CanvasRouteProps) {
  return (
    <section
      className="ros-canvas"
      aria-label="招聘详情画布"
      data-testid="v4-canvas-route"
      data-settings-write-wired={typeof postSettingsWrite === 'function' ? '1' : '0'}
    >
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
          onUploadStarted={onUploadStarted}
          onActionCompleted={onActionCompleted}
          refreshNonce={refreshNonce}
          fetcher={fetcher}
        />
      ) : route.kind === 'job' ? (
        <JobPage
          jobId={route.jobId}
          onBack={onBack}
          onSelectApplication={onSelectApplication}
          onSelectJob={onSelectJob}
          onUploadStarted={onUploadStarted}
          onActionCompleted={onActionCompleted}
          refreshNonce={refreshNonce}
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

export interface CanvasPanelHostProps {
  /** 当前 DSH Session id（写请求的 X-DSH-Session 只从这里来）。 */
  readonly sessionId?: string;
  children: (controls: {
    openCandidate: (applicationId: string) => void;
    openJob: (jobId: string) => void;
    closeCanvas: () => void;
    activeRoute: CanvasRouteTarget;
  }) => React.ReactNode;
  onRefreshOverview?: () => void;
  fetcher?: CanvasFetcher;
}

export function CanvasPanelHost({ children, sessionId, onRefreshOverview, fetcher }: CanvasPanelHostProps) {
  // 把宿主 session 注入画布写请求；卸载/切换 session 时清空（fail-closed）。
  useEffect(() => {
    setCanvasSessionId(sessionId ?? null);
    return () => setCanvasSessionId(null);
  }, [sessionId]);
  const [route, setRoute] = useState<CanvasRouteTarget>({ kind: 'empty' });
  const [prevJobId, setPrevJobId] = useState<string | null>(null);
  const [uploadTask, setUploadTask] = useState<ActiveUploadTask | null>(null);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  const [toast, setToast] = useState<UndoToastPayload | null>(null);
  const [undoBusy, setUndoBusy] = useState<boolean>(false);

  useEffect(() => {
    if (!toast) return;
    const ms = toast.actionId ? 5000 : 2800;
    const timer = setTimeout(() => setToast(null), ms);
    return () => clearTimeout(timer);
  }, [toast]);

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

  const handleUploadCompleted = useCallback(() => {
    setRefreshNonce((n) => n + 1);
    onRefreshOverview?.();
  }, [onRefreshOverview]);

  const handleActionCompleted = useCallback((notice: UndoToastPayload) => {
    setToast(notice);
    onRefreshOverview?.();
  }, [onRefreshOverview]);

  const handleUndoClick = async () => {
    if (!toast?.actionId || undoBusy) return;
    setUndoBusy(true);
    try {
      const res = await postActionUndo({
        actionId: toast.actionId,
        confirmationText: `确认撤销刚刚执行的操作：${toast.message}`,
      });
      setToast({ message: res.message });
      if (res.undone) {
        setRefreshNonce((n) => n + 1);
        onRefreshOverview?.();
      }
    } catch (err) {
      const msg = (err as CanvasActionError)?.userMessage || '暂时无法撤销，请稍后刷新核对';
      setToast({ message: msg });
    } finally {
      setUndoBusy(false);
    }
  };

  return (
    <>
      {route.kind !== 'empty' ? (
        <CanvasRoute
          route={route}
          onBack={handleBack}
          onSelectApplication={openCandidate}
          onSelectJob={openJob}
          uploadTask={uploadTask}
          onUploadStarted={setUploadTask}
          onDismissUploadTask={() => setUploadTask(null)}
          onUploadCompleted={handleUploadCompleted}
          onActionCompleted={handleActionCompleted}
          refreshNonce={refreshNonce}
          fetcher={fetcher}
        />
      ) : (
        children({ openCandidate, openJob, closeCanvas: handleBack, activeRoute: route })
      )}

      {toast ? (
        <div className="ros-toast show" role="status" data-testid="canvas-undo-toast">
          <span>{toast.message}</span>
          {toast.actionId ? (
            <button
              type="button"
              disabled={undoBusy}
              data-testid="canvas-undo-btn"
              style={{ color: '#A5B4FC', fontWeight: 600 }}
              onClick={() => void handleUndoClick()}
            >
              {undoBusy ? '撤销中…' : '撤销'}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export default CanvasRoute;
