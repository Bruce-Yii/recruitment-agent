import React, { useEffect, useRef, useState } from 'react';
import { uploadResumeRaw } from '../client/canvas/canvas-actions.ts';
import type { ActiveUploadTask } from '../client/canvas/CanvasRoute.tsx';
import type { RecruitingOverviewView } from '../client/recruiting/view-model.ts';
import {
  streamAgentTurn,
  type AgentToolEvent,
  type AgentUiAction,
  type AgentUiModalKind,
  type AgentUiWriteProposal,
} from './api.ts';
import { InlineConfirmCard } from './InlineConfirmCard.tsx';
import { formatHashRoute, type AppRoute } from './router.ts';

interface ChatMessage {
  readonly id: string;
  readonly role: 'ai' | 'user';
  readonly text: string;
  readonly tools?: readonly AgentToolEvent[];
  readonly uiNotices?: readonly string[];
  readonly suggestedActions?: readonly AgentUiAction[];
  readonly writeProposals?: readonly AgentUiWriteProposal[];
  readonly streaming?: boolean;
}

interface QuickPromptItem {
  readonly slug: string;
  readonly prompt: string;
}

export interface ChatPanelProps {
  readonly sid: string;
  readonly route: AppRoute;
  readonly overview?: RecruitingOverviewView | null;
  readonly currentJobId?: string;
  readonly defaultJobId?: string;
  readonly onCollapse: () => void;
  readonly onResizeStart: (event: React.MouseEvent) => void;
  readonly onResizeReset: () => void;
  readonly onToolCompleted: (tool: AgentToolEvent) => void;
  readonly onUiAction: (action: AgentUiAction) => void;
  readonly onExecuteSuggestedAction: (action: AgentUiAction) => void;
  readonly onProposalCommitted?: () => void;
  readonly onUploadStarted: (task: ActiveUploadTask) => void;
}

function buildMorningBriefing(overview?: RecruitingOverviewView | null): string {
  const fallback =
    '你好，我是招聘协作 Agent。你可以直接告诉我需要推进哪位候选人，或拖入简历文件自动建档。';
  if (!overview) return fallback;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  const { applicationsActive, awaitingScreening, interviewing, awaitingDecision } = overview.counts;
  if (applicationsActive === 0 && overview.applications.length === 0) {
    return `${greeting}。当前暂无在办候选人，你可以点击左侧「＋ 新建岗位」或直接拖入简历文件开始建档。`;
  }
  const overdueScorecards = overview.applications.reduce(
    (sum, app) =>
      sum + app.interviews.reduce((s, iv) => s + (iv.scorecards?.overdue ?? 0), 0),
    0,
  );
  const items: string[] = [];
  if (awaitingScreening > 0) items.push(`待初筛 ${awaitingScreening} 人`);
  if (interviewing > 0) items.push(`面试中 ${interviewing} 人`);
  if (awaitingDecision > 0) items.push(`待决策 ${awaitingDecision} 人`);
  if (overdueScorecards > 0) items.push(`${overdueScorecards} 份面评已超时`);
  const top = overview.applications[0];
  const topNote = top ? `当前首位待推进：${top.candidateName}（${top.jobTitle}）。` : '';
  const summary =
    items.length > 0
      ? `当前有 ${applicationsActive} 位在办候选人（${items.join('、')}）。`
      : `当前共有 ${overview.applications.length} 位候选人档案。`;
  return `${greeting}。${summary}${topNote}点击右侧列表进入决策画布，或直接告诉我你想处理哪位候选人。`;
}

function quickPromptsForRoute(route: AppRoute): readonly QuickPromptItem[] {
  if (route.kind === 'application') {
    return [
      { slug: 'risk-summary', prompt: '提炼这位候选人的核心风险点' },
      { slug: 'free-slots', prompt: '帮我查下一轮可约时段' },
      { slug: 'compare-rubric', prompt: '对比岗位评分标准' },
    ];
  }
  if (route.kind === 'job') {
    return [
      { slug: 'job-bottlenecks', prompt: '汇总当前岗位推进瓶颈' },
      { slug: 'job-priority', prompt: '筛选最值得优先推进的候选人' },
    ];
  }
  return [
    { slug: 'today-top3', prompt: '梳理今天最优先推进的候选人' },
    { slug: 'pending-scorecards', prompt: '查看待提交面评与催办进展' },
    { slug: 'open-talent', prompt: '打开人才库检索候选人' },
  ];
}

function formatUiActionNotice(action: AgentUiAction): string {
  if (action.label) return action.label;
  if (action.action === 'focus_section') {
    const names: Record<string, string> = {
      summary: '当前状态与提炼',
      criteria: '岗位标准对照',
      resume: '简历原文摘录',
      interviews: '逐轮面试进展',
      rubric: '岗位评分标准',
      candidates: '候选人池',
    };
    return `已定位到${names[action.section ?? ''] || '对应区块'}`;
  }
  if (action.action === 'navigate') {
    const names: Record<string, string> = {
      queue: '今日待办',
      jobs: '在招岗位',
      talent: '人才库',
      application: '候选人档案',
      job: '岗位详情',
      interviewer: '面试官视图',
    };
    return `已切换到${names[action.route ?? ''] || '目标画布'}`;
  }
  return '已联动右侧画布';
}

function suggestActionKey(action: AgentUiAction): string {
  return `${action.modal ?? ''}|${action.route ?? ''}|${action.target_id ?? ''}|${action.label ?? ''}`;
}

function suggestActionTestId(action: AgentUiAction): string {
  const suffix = action.modal || action.route || 'action';
  return `app-chat-suggest-${suffix}`;
}

export function ChatPanel({
  sid,
  route,
  overview,
  currentJobId,
  defaultJobId,
  onCollapse,
  onResizeStart,
  onResizeReset,
  onToolCompleted,
  onUiAction,
  onExecuteSuggestedAction,
  onProposalCommitted,
  onUploadStarted,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: 'welcome',
      role: 'ai',
      text: buildMorningBriefing(overview),
    },
  ]);

  useEffect(() => {
    if (!overview) return;
    const nextText = buildMorningBriefing(overview);
    setMessages((prev) => {
      if (prev.length !== 1 || prev[0]?.id !== 'welcome') return prev;
      if (prev[0].text === nextText) return prev;
      return [{ ...prev[0], text: nextText }];
    });
  }, [overview]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [unavailableMsg, setUnavailableMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const streamRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = streamRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const appendAiNotice = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: 'ai', text },
    ]);
  };

  const handleFileUpload = async (file: File) => {
    const jobId = route.kind === 'job' ? route.jobId : defaultJobId || '';
    if (!jobId) {
      appendAiNotice('当前还没有可归属的在招岗位，请先在「在招岗位」中确认岗位后再上传简历。');
      return;
    }
    setUploading(true);
    appendAiNotice(`正在上传「${file.name}」，解析完成后会自动同步到右侧工作台…`);
    try {
      const started = await uploadResumeRaw(file, jobId);
      onUploadStarted({ taskId: started.taskId, fileName: file.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '简历上传失败，请稍后重试。';
      appendAiNotice(msg);
    } finally {
      setUploading(false);
    }
  };

  const sendText = async (rawText: string) => {
    const text = rawText.trim();
    if (!text || sending) return;

    const userId = `u-${Date.now()}`;
    const aiId = `a-${Date.now() + 1}`;
    setInput('');
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text },
      { id: aiId, role: 'ai', text: '', tools: [], streaming: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    await streamAgentTurn({
      sid,
      text,
      context: {
        route: formatHashRoute(route),
        application_id: route.kind === 'application' ? route.applicationId : undefined,
        job_id:
          route.kind === 'job'
            ? route.jobId
            : route.kind === 'application'
              ? currentJobId
              : undefined,
      },
      signal: controller.signal,
      onDelta: (chunk) => {
        setUnavailableMsg(null);
        setMessages((prev) =>
          prev.map((m) => (m.id === aiId ? { ...m, text: m.text + chunk } : m)),
        );
      },
      onTool: (tool) => {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== aiId) return m;
            const list = [...(m.tools ?? [])];
            const idx = list.findIndex((item) => item.name === tool.name && item.status === 'start');
            if (idx >= 0 && tool.status !== 'start') {
              list[idx] = tool;
            } else {
              list.push(tool);
            }
            return { ...m, tools: list };
          }),
        );
        if (tool.status === 'ok' && tool.name !== 'recruitment_ui_dispatch') {
          onToolCompleted(tool);
        }
      },
      onUiAction: (uiAction) => {
        if (uiAction.action === 'propose_write' && uiAction.proposal) {
          const proposal = uiAction.proposal;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== aiId) return m;
              const existing = m.writeProposals ?? [];
              const key = `${proposal.intent}:${proposal.application_id}:${proposal.title}`;
              if (
                existing.some(
                  (item) => `${item.intent}:${item.application_id}:${item.title}` === key,
                )
              ) {
                return m;
              }
              return { ...m, writeProposals: [...existing, proposal] };
            }),
          );
          return;
        }
        if (uiAction.action === 'suggest_action') {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== aiId) return m;
              const existing = m.suggestedActions ?? [];
              const key = suggestActionKey(uiAction);
              if (existing.some((item) => suggestActionKey(item) === key)) {
                return m;
              }
              return { ...m, suggestedActions: [...existing, uiAction] };
            }),
          );
          return;
        }
        onUiAction(uiAction);
        const notice = formatUiActionNotice(uiAction);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== aiId) return m;
            const existing = m.uiNotices ?? [];
            if (existing.includes(notice)) return m;
            return { ...m, uiNotices: [...existing, notice] };
          }),
        );
      },
      onDone: () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === aiId
              ? { ...m, streaming: false, text: m.text || '已完成处理。' }
              : m,
          ),
        );
        setSending(false);
      },
      onUnavailable: (message) => {
        setUnavailableMsg(message || '对话暂时不可用，右侧工作台操作不受影响。');
        setMessages((prev) =>
          prev.map((m) =>
            m.id === aiId
              ? { ...m, streaming: false, text: '对话暂时不可用，你可以继续直接使用右侧工作台完成所有业务操作。' }
              : m,
          ),
        );
        setSending(false);
      },
      onError: (message) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === aiId ? { ...m, streaming: false, text: message } : m,
          ),
        );
        setSending(false);
      },
    });
  };

  const quickPrompts = quickPromptsForRoute(route);

  return (
    <section
      className={`chat-col ${dragOver ? 'drag-over' : ''}`}
      data-testid="app-chat-panel"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void handleFileUpload(file);
      }}
    >
      <div
        className="chat-resizer"
        title="拖拽调节对话栏宽度，双击还原默认"
        onMouseDown={onResizeStart}
        onDoubleClick={onResizeReset}
      />
      <div className="drop-overlay">
        <span>松开鼠标，立即上传并解析简历</span>
      </div>

      <header className="chat-head">
        <span className="chat-title">
          <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, fill: 'var(--iris)' }}>
            <path d="M12 2.5 14.3 9l6.5 2.3-6.5 2.3L12 20.1l-2.3-6.5L3.2 11.3 9.7 9 12 2.5Z" />
          </svg>
          Agent
        </span>
        <button
          type="button"
          className="icon-btn"
          title="收起对话栏"
          aria-label="收起对话栏"
          onClick={onCollapse}
        >
          <svg viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      </header>

      {unavailableMsg ? (
        <div className="agent-degraded-bar" data-testid="app-chat-unavailable">
          {unavailableMsg}
        </div>
      ) : null}

      <div className="chat-stream" ref={streamRef} data-testid="app-chat-log">
        {messages.map((msg) => (
          <div key={msg.id} className={`msg ${msg.role}`}>
            {msg.text ? <div>{msg.text}</div> : null}
            {msg.streaming && !msg.text ? (
              <span className="thinking-row">
                <i className="thinking-dot" />
                正在思考并读取最新数据…
              </span>
            ) : null}
            {msg.tools && msg.tools.length > 0 ? (
              <div className="msg-tool-list">
                {msg.tools.map((t, idx) => (
                  <span
                    key={`${t.name}-${idx}`}
                    className={`msg-action-tag ${t.status}`}
                  >
                    {t.status === 'start' ? '执行中 · ' : t.status === 'ok' ? '已完成 · ' : '失败 · '}
                    {t.name}
                  </span>
                ))}
              </div>
            ) : null}
            {msg.uiNotices && msg.uiNotices.length > 0 ? (
              <div className="msg-ui-notices">
                {msg.uiNotices.map((notice, idx) => (
                  <span key={`${notice}-${idx}`} className="msg-ui-notice">
                    ↗ {notice}
                  </span>
                ))}
              </div>
            ) : null}
            {msg.writeProposals && msg.writeProposals.length > 0 ? (
              <div className="msg-confirm-list">
                {msg.writeProposals.map((proposal, idx) => (
                  <InlineConfirmCard
                    key={`${proposal.intent}-${proposal.application_id}-${idx}`}
                    sid={sid}
                    proposal={proposal}
                    onCommitted={() => onProposalCommitted?.()}
                    onFallbackModal={(modal: AgentUiModalKind, applicationId: string) =>
                      onExecuteSuggestedAction({
                        action: 'suggest_action',
                        route: 'application',
                        target_id: applicationId,
                        modal,
                        label: '在弹窗微调',
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            {msg.suggestedActions && msg.suggestedActions.length > 0 ? (
              <div className="msg-suggest-list">
                {msg.suggestedActions.map((act, idx) => (
                  <button
                    key={`${suggestActionKey(act)}-${idx}`}
                    type="button"
                    className="msg-suggest-btn"
                    data-testid={suggestActionTestId(act)}
                    onClick={() => onExecuteSuggestedAction(act)}
                  >
                    <span>{act.label || '执行建议操作'}</span>
                    <span className="msg-suggest-arrow" aria-hidden="true">→</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="quick-list">
        {quickPrompts.map((item) => (
          <button
            key={item.slug}
            type="button"
            className="q-pill"
            data-testid={`app-chat-quick-${item.slug}`}
            disabled={sending}
            onClick={() => void sendText(item.prompt)}
          >
            {item.prompt}
          </button>
        ))}
      </div>

      <div className="composer-wrap">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void sendText(input);
          }}
        >
          <button
            type="button"
            className="icon-btn"
            title="导入简历 PDF / DOCX"
            aria-label="导入简历"
            disabled={uploading}
            style={{ width: 26, height: 26, marginLeft: -2 }}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt"
            data-testid="app-chat-upload"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileUpload(file);
              e.target.value = '';
            }}
          />
          <input
            data-testid="app-chat-input"
            value={input}
            disabled={sending}
            onChange={(e) => setInput(e.target.value)}
            placeholder="告诉 Agent 你想做什么，或点左侧 ＋ 导入简历…"
          />
          <button
            type="submit"
            className="send-circle"
            data-testid="app-chat-send"
            disabled={sending || !input.trim()}
            aria-label="发送"
          >
            <svg viewBox="0 0 24 24">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </form>
      </div>
    </section>
  );
}
