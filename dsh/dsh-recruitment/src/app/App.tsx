import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CanvasRoute,
  type ActiveUploadTask,
  type CanvasFocusRequest,
  type CanvasModalRequest,
  type CanvasRouteTarget,
} from '../client/canvas/CanvasRoute.tsx';
import { invalidateCachedCanvasData } from '../client/canvas/canvas-ux.ts';
import { InterviewerWorkspace } from '../client/interviewer/InterviewerWorkspace.tsx';
import type { RecruitingOverviewView } from '../client/recruiting/view-model.ts';
import {
  fetchAppJson,
  fetchAppOverview,
  fetchAppSession,
  formatRolesLabel,
  isInterviewerOnly,
  type AgentUiAction,
  type AppSessionInfo,
} from './api.ts';
import { ChatPanel } from './ChatPanel.tsx';
import { JobsView } from './JobsView.tsx';
import { QueueView, type QueueFilterRequest } from './QueueView.tsx';
import { formatHashRoute, navigateToRoute, parseHashRoute, type AppRoute } from './router.ts';
import { TalentView } from './TalentView.tsx';

export function App() {
  const [session, setSession] = useState<AppSessionInfo | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');

  const [overview, setOverview] = useState<RecruitingOverviewView | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState('');

  const [route, setRoute] = useState<AppRoute>(() => parseHashRoute(window.location.hash));
  const [candidateQueue, setCandidateQueue] = useState<string[]>([]);
  const [uploadTask, setUploadTask] = useState<ActiveUploadTask | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [queueFilterReq, setQueueFilterReq] = useState<QueueFilterRequest | null>(null);
  const [focusRequest, setFocusRequest] = useState<CanvasFocusRequest | null>(null);
  const [openModalRequest, setOpenModalRequest] = useState<CanvasModalRequest | null>(null);
  const [resolvedCandidateJobId, setResolvedCandidateJobId] = useState<string | undefined>(undefined);
  const uiActionNonceRef = useRef(1);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return window.localStorage.getItem('ros-v4-theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 1080 : false,
  );
  const [chatWidth, setChatWidth] = useState(324);
  const [resizing, setResizing] = useState(false);
  const [isOffline, setIsOffline] = useState(() =>
    typeof navigator !== 'undefined' ? !navigator.onLine : false,
  );

  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [settingsInfo, setSettingsInfo] = useState<Record<string, unknown> | null>(null);

  const hiddenAtRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('ros-v4-theme', theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  useEffect(() => {
    const syncRoute = () => setRoute(parseHashRoute(window.location.hash));
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('popstate', syncRoute);
    return () => {
      window.removeEventListener('hashchange', syncRoute);
      window.removeEventListener('popstate', syncRoute);
    };
  }, []);

  const loadOverview = useCallback(async (sid: string) => {
    setOverviewLoading(true);
    setOverviewError('');
    try {
      const data = await fetchAppOverview(sid);
      setOverview(data);
      setCandidateQueue((prev) =>
        prev.length > 0 ? prev : data.applications.map((a) => a.id),
      );
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : '加载工作台失败');
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setSessionLoading(true);
    setSessionError('');
    try {
      const info = await fetchAppSession();
      setSession(info);
      if (info.bound) {
        if (isInterviewerOnly(info.roles) && parseHashRoute(window.location.hash).kind === 'queue') {
          navigateToRoute({ kind: 'interviewer' }, true);
        } else if (!isInterviewerOnly(info.roles)) {
          await loadOverview(info.sid);
        }
      }
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : '初始化会话失败');
    } finally {
      setSessionLoading(false);
    }
  }, [loadOverview]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const onOffline = () => setIsOffline(true);
    const onOnline = () => {
      setIsOffline(false);
      if (session?.bound && !isInterviewerOnly(session.roles)) {
        void loadOverview(session.sid);
        setRefreshNonce((n) => n + 1);
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
      } else if (hiddenAtRef.current && Date.now() - hiddenAtRef.current > 30_000) {
        hiddenAtRef.current = null;
        if (session?.bound && !isInterviewerOnly(session.roles)) {
          void loadOverview(session.sid);
          setRefreshNonce((n) => n + 1);
        }
      }
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [session, loadOverview]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (inInput) return;
      if (e.key === '\\') {
        e.preventDefault();
        setRailCollapsed((v) => !v);
      } else if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      } else if (e.key === 'Escape') {
        setShowSettings(false);
        setShowShortcuts(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startW = chatWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(260, Math.min(520, startW + (ev.clientX - startX)));
      setChatWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [chatWidth]);

  const handleRefreshAll = useCallback(() => {
    if (route.kind === 'application') {
      invalidateCachedCanvasData(
        `/recruitment/api/recruiting/applications/${encodeURIComponent(route.applicationId)}`,
      );
    } else if (route.kind === 'job') {
      invalidateCachedCanvasData(
        `/recruitment/api/recruiting/jobs/${encodeURIComponent(route.jobId)}`,
      );
    }
    setRefreshNonce((n) => n + 1);
    if (session?.bound && !isInterviewerOnly(session.roles)) {
      void loadOverview(session.sid);
    }
  }, [route, session, loadOverview]);

  const openSettings = async () => {
    setShowSettings(true);
    if (session?.sid) {
      try {
        const [settings, usage] = await Promise.all([
          fetchAppJson('/recruitment/api/settings', session.sid).catch(() => ({})),
          fetchAppJson('/recruitment/api/usage', session.sid).catch(() => ({})),
        ]);
        setSettingsInfo({ settings, usage });
      } catch {
        setSettingsInfo({});
      }
    }
  };

  useEffect(() => {
    setResolvedCandidateJobId(undefined);
  }, [route.kind, route.kind === 'application' ? route.applicationId : '']);

  const currentCandidateJobId = useMemo(() => {
    if (route.kind !== 'application') return undefined;
    const fromOverview = overview?.applications.find((a) => a.id === route.applicationId)?.jobId;
    return fromOverview || resolvedCandidateJobId;
  }, [route, overview, resolvedCandidateJobId]);

  const applyUiNavigation = useCallback(
    (uiAction: AgentUiAction) => {
      if (!uiAction.route) return;
      let target: AppRoute | null = null;
      if (uiAction.route === 'queue') {
        if (uiAction.filter) {
          uiActionNonceRef.current += 1;
          setQueueFilterReq({ filter: uiAction.filter, nonce: uiActionNonceRef.current });
        }
        target = { kind: 'queue' };
      } else if (uiAction.route === 'jobs') {
        target = { kind: 'jobs' };
      } else if (uiAction.route === 'talent') {
        target = { kind: 'talent' };
      } else if (uiAction.route === 'interviewer') {
        target = { kind: 'interviewer' };
      } else if (uiAction.route === 'application' && uiAction.target_id) {
        target = { kind: 'application', applicationId: uiAction.target_id };
      } else if (uiAction.route === 'job' && uiAction.target_id) {
        target = { kind: 'job', jobId: uiAction.target_id };
      }
      if (target && formatHashRoute(target) !== formatHashRoute(route)) {
        navigateToRoute(target);
      }
    },
    [route],
  );

  const handleAgentUiAction = useCallback(
    (uiAction: AgentUiAction) => {
      if (uiAction.action === 'navigate') {
        applyUiNavigation(uiAction);
      } else if (uiAction.action === 'focus_section' && uiAction.section) {
        uiActionNonceRef.current += 1;
        setFocusRequest({ section: uiAction.section, nonce: uiActionNonceRef.current });
      }
      // suggest_action never auto-navigates or auto-opens modals; only executed on user click.
    },
    [applyUiNavigation],
  );

  const handleExecuteSuggestedAction = useCallback(
    (uiAction: AgentUiAction) => {
      if (uiAction.route) {
        applyUiNavigation(uiAction);
      }
      if (uiAction.modal) {
        uiActionNonceRef.current += 1;
        setOpenModalRequest({ modal: uiAction.modal, nonce: uiActionNonceRef.current });
      }
    },
    [applyUiNavigation],
  );

  const handleFocusConsumed = useCallback(() => setFocusRequest(null), []);
  const handleModalConsumed = useCallback(() => setOpenModalRequest(null), []);
  const handleFilterConsumed = useCallback(() => setQueueFilterReq(null), []);

  const canvasRouteTarget = useMemo<CanvasRouteTarget>(() => {
    if (route.kind === 'application') {
      return { kind: 'candidate', applicationId: route.applicationId };
    }
    if (route.kind === 'job') {
      return { kind: 'job', jobId: route.jobId };
    }
    return { kind: 'empty' };
  }, [route]);

  if (sessionLoading) {
    return (
      <div className="unbound-screen" data-testid="app-loading">
        <div className="unbound-card">
          <span className="brand-dot" style={{ width: 32, height: 32, borderRadius: 10 }}>
            <svg viewBox="0 0 24 24">
              <path d="M12 2.5 14.3 9l6.5 2.3-6.5 2.3L12 20.1l-2.3-6.5L3.2 11.3 9.7 9 12 2.5Z" />
            </svg>
          </span>
          <h1>Recruitment OS</h1>
          <p>正在连接工作台会话…</p>
        </div>
      </div>
    );
  }

  if (sessionError || !session) {
    return (
      <div className="unbound-screen" data-testid="app-session-error">
        <div className="unbound-card">
          <h1>无法连接工作台</h1>
          <p>{sessionError || '会话服务暂时无响应，请稍后重试。'}</p>
          <button type="button" className="btn dark" onClick={() => void bootstrap()}>
            重新连接
          </button>
        </div>
      </div>
    );
  }

  if (!session.bound) {
    return (
      <div className="unbound-screen" data-testid="app-unbound-screen">
        <div className="unbound-card">
          <span className="brand-dot" style={{ width: 32, height: 32, borderRadius: 10 }}>
            <svg viewBox="0 0 24 24">
              <path d="M12 2.5 14.3 9l6.5 2.3-6.5 2.3L12 20.1l-2.3-6.5L3.2 11.3 9.7 9 12 2.5Z" />
            </svg>
          </span>
          <h1>尚未选择身份，请联系管理员绑定</h1>
          <p>当前会话尚未关联到有效的招聘成员身份，因此工作台已保持只读隔离状态。</p>
          <button type="button" className="btn" onClick={() => void bootstrap()}>
            刷新状态
          </button>
        </div>
      </div>
    );
  }

  const interviewerOnly = isInterviewerOnly(session.roles);
  const isInterviewerRoute = route.kind === 'interviewer' || interviewerOnly;
  const isEmbeddedDetail = !isInterviewerRoute && (route.kind === 'application' || route.kind === 'job');
  const activeSpace =
    route.kind === 'jobs' || route.kind === 'job'
      ? 'jobs'
      : route.kind === 'talent'
        ? 'talent'
        : 'queue';

  const actorName = session.displayName || session.alias || '已认证成员';
  const actorRoleText = formatRolesLabel(session.roles, actorName);

  const actorBadgeNode = (
    <div className="actor-badge" data-testid="app-actor-badge">
      <i className="actor-badge-dot" />
      <span>{actorName}</span>
      {actorRoleText ? <span className="actor-badge-role">{actorRoleText}</span> : null}
    </div>
  );

  return (
    <div
      data-rail={railCollapsed ? 'collapsed' : 'expanded'}
      data-chat={chatCollapsed ? 'collapsed' : 'expanded'}
      style={{ height: '100%', width: '100%' }}
    >
      <div
        className={`shell ${resizing ? 'resizing' : ''}`}
        style={{ ['--chat-w' as string]: `${chatWidth}px` }}
      >
        {/* 1. Left Slim Space Rail */}
        <aside className="space-rail" aria-label="一级空间导航">
          <div className="rail-brand">
            <div className="brand-identity">
              <span className="brand-dot">
                <svg viewBox="0 0 24 24">
                  <path d="M12 2.5 14.3 9l6.5 2.3-6.5 2.3L12 20.1l-2.3-6.5L3.2 11.3 9.7 9 12 2.5Z" />
                </svg>
              </span>
              <span style={{ whiteSpace: 'nowrap' }}>Recruitment OS</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              title="收起 / 展开导航栏 (\)"
              aria-label="收起或展开导航栏"
              onClick={() => setRailCollapsed((v) => !v)}
            >
              <svg viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
              </svg>
            </button>
          </div>

          <nav className="rail-nav">
            {isInterviewerRoute ? (
              <button
                type="button"
                className="rail-btn active"
                title="我的面试安排"
                onClick={() => navigateToRoute({ kind: 'interviewer' })}
              >
                <span className="rail-btn-l">
                  <svg viewBox="0 0 24 24">
                    <path d="M8 2v4M16 2v4M3 10h18" />
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                  </svg>
                  <span className="rail-lbl">我的面试</span>
                </span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={`rail-btn ${activeSpace === 'queue' && route.kind !== 'application' ? 'active' : ''}`}
                  data-testid="app-nav-queue"
                  title="今日待办"
                  onClick={() => navigateToRoute({ kind: 'queue' })}
                >
                  <span className="rail-btn-l">
                    <svg viewBox="0 0 24 24">
                      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                      <path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z" />
                    </svg>
                    <span className="rail-lbl">今日待办</span>
                  </span>
                  <span className="rail-cnt num">{overview?.counts.applicationsActive ?? 0}</span>
                </button>

                <button
                  type="button"
                  className={`rail-btn ${activeSpace === 'jobs' ? 'active' : ''}`}
                  data-testid="app-nav-jobs"
                  title="在招岗位"
                  onClick={() => navigateToRoute({ kind: 'jobs' })}
                >
                  <span className="rail-btn-l">
                    <svg viewBox="0 0 24 24">
                      <rect x="2" y="7" width="20" height="14" rx="2" />
                      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                    </svg>
                    <span className="rail-lbl">在招岗位</span>
                  </span>
                  <span className="rail-cnt num">{overview?.counts.jobsOpen ?? 0}</span>
                </button>

                {overview && overview.jobs.length > 0 ? (
                  <div className="rail-jobs">
                    {overview.jobs.map((job) => (
                      <button
                        key={job.id}
                        type="button"
                        className={`rail-job ${route.kind === 'job' && route.jobId === job.id ? 'active' : ''}`}
                        onClick={() => navigateToRoute({ kind: 'job', jobId: job.id })}
                      >
                        <span className="rail-job-name">{job.title}</span>
                        <span className="rail-job-hc num">{job.applicationCounts.active}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <button
                  type="button"
                  className={`rail-btn ${activeSpace === 'talent' ? 'active' : ''}`}
                  data-testid="app-nav-talent"
                  title="人才库"
                  onClick={() => navigateToRoute({ kind: 'talent' })}
                >
                  <span className="rail-btn-l">
                    <svg viewBox="0 0 24 24">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
                    </svg>
                    <span className="rail-lbl">人才库</span>
                  </span>
                  <span className="rail-cnt num">{overview?.counts.applicationsTotal ?? 0}</span>
                </button>
              </>
            )}
          </nav>

          <div className="rail-foot">
            <button
              type="button"
              className="icon-btn"
              title="收起 / 展开对话栏"
              aria-label="收起或展开对话栏"
              onClick={() => setChatCollapsed((v) => !v)}
            >
              <svg viewBox="0 0 24 24">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              title="切换深浅色"
              aria-label="切换深浅色"
              onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            >
              <svg viewBox="0 0 24 24">
                <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              title="系统状态与用量"
              aria-label="系统状态与用量"
              onClick={() => void openSettings()}
            >
              <svg viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.66 0-1.25.4-1.51 1Z" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              title="快捷键 ?"
              aria-label="快捷键"
              onClick={() => setShowShortcuts(true)}
            >
              <svg viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" />
                <path d="M12 17h.01" />
              </svg>
            </button>
          </div>
        </aside>

        {/* 2. Accompanying Agent Dialogue Column */}
        <ChatPanel
          sid={session.sid}
          route={route}
          currentJobId={currentCandidateJobId}
          defaultJobId={overview?.jobs[0]?.id}
          onCollapse={() => setChatCollapsed(true)}
          onResizeStart={handleResizeStart}
          onResizeReset={() => setChatWidth(324)}
          onToolCompleted={() => handleRefreshAll()}
          onUiAction={handleAgentUiAction}
          onExecuteSuggestedAction={handleExecuteSuggestedAction}
          onUploadStarted={(task) => setUploadTask(task)}
        />

        {/* 3. Contextual Main White Canvas */}
        <section className="canvas-col" data-testid="app-canvas">
          {!isEmbeddedDetail ? (
            <header className="canvas-head">
              <div className="canvas-head-left">
                {chatCollapsed ? (
                  <button
                    type="button"
                    className="icon-btn"
                    title="展开对话栏"
                    aria-label="展开对话栏"
                    onClick={() => setChatCollapsed(false)}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                ) : null}

                <div className="crumb-bar">
                  {isInterviewerRoute ? (
                    <span className="crumb-cur">我的面试与独立面评</span>
                  ) : route.kind === 'jobs' ? (
                    <span className="crumb-cur">在招岗位</span>
                  ) : route.kind === 'talent' ? (
                    <span className="crumb-cur">人才库</span>
                  ) : (
                    <span className="crumb-cur">今日待办</span>
                  )}
                </div>
              </div>

              <div className="canvas-right-meta">
                {isOffline ? <span style={{ color: 'var(--amber)' }}>离线</span> : null}
                {actorBadgeNode}
              </div>
            </header>
          ) : (
            <div className="embedded-actor-slot">
              {chatCollapsed ? (
                <button
                  type="button"
                  className="icon-btn"
                  title="展开对话栏"
                  aria-label="展开对话栏"
                  onClick={() => setChatCollapsed(false)}
                >
                  <svg viewBox="0 0 24 24">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              ) : null}
              {actorBadgeNode}
            </div>
          )}

          <div
            className={`canvas-body ${isEmbeddedDetail ? 'embedded-canvas' : ''}`}
          >
            {isOffline ? (
              <div style={{ maxWidth: 820, margin: '0 auto 16px' }}>
                <div className="offline-banner">
                  <span>当前网络连接已断开，恢复在线后将自动同步最新数据。</span>
                </div>
              </div>
            ) : null}

            {isInterviewerRoute ? (
              <div className="interviewer-host" data-testid="app-interviewer-view">
                <InterviewerWorkspace sessionId={session.sid} alias={session.alias} />
              </div>
            ) : isEmbeddedDetail ? (
              <CanvasRoute
                sessionId={session.sid}
                route={canvasRouteTarget}
                candidateQueue={candidateQueue}
                isOffline={isOffline}
                focusRequest={focusRequest}
                onFocusConsumed={handleFocusConsumed}
                openModalRequest={openModalRequest}
                onModalRequestConsumed={handleModalConsumed}
                onCandidateJobResolved={setResolvedCandidateJobId}
                refreshNonce={refreshNonce}
                uploadTask={uploadTask}
                onBack={() =>
                  navigateToRoute(route.kind === 'job' ? { kind: 'jobs' } : { kind: 'queue' })
                }
                onSelectApplication={(applicationId, queue) => {
                  if (queue && queue.length > 0) setCandidateQueue(queue);
                  navigateToRoute({ kind: 'application', applicationId });
                }}
                onSelectJob={(jobId) => navigateToRoute({ kind: 'job', jobId })}
                onUploadStarted={(task) => setUploadTask(task)}
                onDismissUploadTask={() => setUploadTask(null)}
                onUploadCompleted={() => handleRefreshAll()}
                onActionCompleted={() => {
                  if (session?.sid) void loadOverview(session.sid);
                }}
              />
            ) : overviewLoading && !overview ? (
              <div className="canvas-inner">
                <div className="empty-paper">正在加载工作台数据…</div>
              </div>
            ) : overviewError && !overview ? (
              <div className="canvas-inner">
                <div className="empty-paper">
                  <div>{overviewError}</div>
                  <button
                    type="button"
                    className="btn dark"
                    onClick={() => void loadOverview(session.sid)}
                  >
                    重试
                  </button>
                </div>
              </div>
            ) : overview ? (
              route.kind === 'jobs' ? (
                <JobsView
                  overview={overview}
                  onOpenJob={(jobId) => navigateToRoute({ kind: 'job', jobId })}
                />
              ) : route.kind === 'talent' ? (
                <TalentView
                  overview={overview}
                  onOpenApplication={(applicationId, queue) => {
                    setCandidateQueue(queue);
                    navigateToRoute({ kind: 'application', applicationId });
                  }}
                />
              ) : (
                <QueueView
                  overview={overview}
                  filterRequest={queueFilterReq}
                  onFilterConsumed={handleFilterConsumed}
                  onOpenApplication={(applicationId, queue) => {
                    setCandidateQueue(queue);
                    navigateToRoute({ kind: 'application', applicationId });
                  }}
                  onUploadStarted={(task) => setUploadTask(task)}
                />
              )
            ) : null}
          </div>
        </section>
      </div>

      {showSettings ? (
        <div className="modal-bg" onClick={() => setShowSettings(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>工作台状态</h2>
              <button type="button" className="btn" onClick={() => setShowSettings(false)}>
                关闭
              </button>
            </div>
            <div className="kv-list">
              <div className="kv-row">
                <span className="kv-k">当前身份</span>
                <span className="kv-v">{actorName}</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">角色</span>
                <span className="kv-v">{actorRoleText || actorName}</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">当前路由</span>
                <span className="kv-v">{formatHashRoute(route)}</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">在招岗位 / 在办申请</span>
                <span className="kv-v num">
                  {overview ? `${overview.counts.jobsOpen} / ${overview.counts.applicationsActive}` : '—'}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-k">配置版本</span>
                <span className="kv-v">{settingsInfo ? '已同步' : '读取中…'}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showShortcuts ? (
        <div className="modal-bg" onClick={() => setShowShortcuts(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>快捷键</h2>
              <button type="button" className="btn" onClick={() => setShowShortcuts(false)}>
                关闭
              </button>
            </div>
            <div className="kv-list">
              <div className="kv-row">
                <span className="kv-k">收起 / 展开左侧导航栏</span>
                <span className="kv-v">\</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">候选人详情页上一位 / 下一位</span>
                <span className="kv-v">[ / ]</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">弹窗快速提交</span>
                <span className="kv-v">⌘ / Ctrl + Enter</span>
              </div>
              <div className="kv-row">
                <span className="kv-k">关闭弹窗 / 返回</span>
                <span className="kv-v">Esc</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
