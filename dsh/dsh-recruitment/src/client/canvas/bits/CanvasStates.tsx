import React from 'react';

export interface CanvasEmptyStateProps {
  title: string;
  description?: string;
}

export function CanvasEmptyState({ title, description }: CanvasEmptyStateProps) {
  return (
    <div className="ros-state-box" role="status">
      <div className="ros-state-title">{title}</div>
      {description ? <div className="ros-state-desc">{description}</div> : null}
    </div>
  );
}

export interface CanvasLoadingStateProps {
  label?: string;
}

export function CanvasLoadingState({ label = '正在读取档案数据…' }: CanvasLoadingStateProps) {
  return (
    <div className="ros-state-box" role="status" aria-live="polite">
      <div className="ros-thinking-row">
        <i className="ros-thinking-dot" />
        <span>{label}</span>
      </div>
    </div>
  );
}

export interface CanvasErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

/**
 * Always renders human-readable copy; never exposes HTTP status codes,
 * stack traces, or internal identifiers.
 */
export function CanvasErrorState({
  message = '暂时没能读取到这份资料，可能是服务刚重启或网络波动。',
  onRetry,
}: CanvasErrorStateProps) {
  return (
    <div className="ros-state-box" role="alert">
      <div className="ros-state-title">读取失败</div>
      <div className="ros-state-desc">{message}</div>
      {onRetry ? (
        <button type="button" className="ros-btn" onClick={onRetry}>
          重新读取
        </button>
      ) : null}
    </div>
  );
}
