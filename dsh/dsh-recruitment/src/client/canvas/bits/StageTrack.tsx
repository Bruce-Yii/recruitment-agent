import React from 'react';
import type { InterviewRoundVM, JobStageNodeVM } from '../../normalize-canvas';

export interface StageTrackProps {
  nodes: JobStageNodeVM[];
}

export function StageTrack({ nodes }: StageTrackProps) {
  return (
    <div className="ros-stage-track" aria-label="招聘六阶段进度">
      {nodes.map((node) => (
        <div key={node.label} className={`ros-st-node ${node.state}`}>
          <div className="ros-st-dot">
            {node.state === 'done' ? '✓' : node.state === 'wait' ? '!' : node.state === 'now' ? '•' : ''}
          </div>
          <span className="ros-st-lbl">
            {node.label}
            {node.count > 0 && node.label !== '标准' ? ` · ${node.count}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface SequentialRoundRailProps {
  rounds: InterviewRoundVM[];
}

export function SequentialRoundRail({ rounds }: SequentialRoundRailProps) {
  if (rounds.length === 0) return null;
  return (
    <div className="ros-seq-rail" aria-label="逐轮面试进展">
      {rounds.map((rd, idx) => (
        <React.Fragment key={rd.id}>
          {idx > 0 ? <div className={`ros-seq-l ${rd.statusTone === 'done' ? 'done' : ''}`} /> : null}
          <div className="ros-seq-n">
            <span className={`ros-seq-d ${rd.statusTone}`}>
              {rd.statusTone === 'done' ? '✓' : idx + 1}
            </span>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600 }}>{rd.roundLabel}</div>
              <div style={{ fontSize: '11px', color: 'var(--muted)' }}>{rd.statusText}</div>
            </div>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
