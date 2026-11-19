import React, { useEffect, useRef, useState } from 'react';
import { uploadResumeRaw } from '../client/canvas/canvas-actions.ts';
import type { ActiveUploadTask } from '../client/canvas/CanvasRoute.tsx';
import { streamAgentTurn, type AgentToolEvent } from './api.ts';
import { formatHashRoute, type AppRoute } from './router.ts';

interface ChatMessage {
  readonly id: string;
  readonly role: 'ai' | 'user';
  readonly text: string;
  readonly tools?: readonly AgentToolEvent[];
  readonly streaming?: boolean;
}

export interface ChatPanelProps {
  readonly sid: string;
  readonly route: AppRoute;
  readonly defaultJobId?: string;
  readonly onCollapse: () => void;
  readonly onResizeStart: (event: React.MouseEvent) => void;
  readonly onResizeReset: () => void;
  readonly onToolCompleted: (tool: AgentToolEvent) => void;
  readonly onUploadStarted: (task: ActiveUploadTask) => void;
}

function quickPromptsForRoute(route: AppRoute): readonly string[] {
  if (route.kind === 'application') {
    return ['总结这位候选人的核心风险点', '帮我查下一轮可约时段', '对比岗位评分标准'];
  }
  if (route.kind === 'job') {
    return ['汇总当前岗位各阶段推进瓶颈', '哪些候选人最值得优先推进？'];
  }
  return ['今天最优先处理的 3 位候选人是谁？', '查看当前待提交面评的进展'];
}

export function ChatPanel({
  sid,
  route,
  defaultJobId,
  onCollapse,
  onResizeStart,
  onResizeReset,
  onToolCompleted,
  onUploadStarted,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'ai',
      text: '你好，我是招聘协作 Agent。你可以直接告诉我需要推进哪位候选人，或拖入简历文件自动建档。',
    },
  ]);
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
        job_id: route.kind === 'job' ? route.jobId : undefined,
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
        if (tool.status === 'ok') {
          onToolCompleted(tool);
        }
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
          </div>
        ))}
      </div>

      <div className="quick-list">
        {quickPrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="q-pill"
            disabled={sending}
            onClick={() => void sendText(prompt)}
          >
            {prompt}
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
