import React from 'react';
import type { FactLabelChip } from '../../normalize-canvas';

export interface FactLabelsBarProps {
  labels: FactLabelChip[];
}

/**
 * Displays external fact labels verbatim (LIVE/FIXTURE, EVENT/MANUAL,
 * CONNECTED/NOT_CONNECTED/AUTH_REQUIRED) without beautifying or hiding them.
 */
export function FactLabelsBar({ labels }: FactLabelsBarProps) {
  if (!labels || labels.length === 0) return null;
  return (
    <div className="ros-fact-bar" aria-label="数据来源与连接状态">
      {labels.map((chip) => (
        <span
          key={`${chip.dimension}-${chip.raw}`}
          className={`ros-fact-chip ${chip.tone === 'neutral' ? '' : chip.tone}`}
        >
          <span>{chip.dimension}</span>
          <span>{chip.raw}</span>
        </span>
      ))}
    </div>
  );
}

export interface StatusLabelProps {
  text: string;
  tone?: 'green' | 'amber' | 'red' | 'iris' | '';
}

export function StatusLabel({ text, tone = '' }: StatusLabelProps) {
  return <span className={`ros-status ${tone}`}>{text}</span>;
}
