/**
 * <StatBadge> 计数与占比徽标
 * 被苗木批次页、栽植记录页、补植计划页、验收台消费。
 */
import type { ReactNode } from 'react';
import { Progress, Tooltip } from 'antd';

export type StatTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface StatBadgeProps {
  label: string;
  value: number | string;
  /** 数值后缀，如「株」「条」「%」 */
  suffix?: string;
  /** 占比（0–100），传入后渲染进度条 */
  percent?: number;
  tone?: StatTone;
  icon?: ReactNode;
  hint?: string;
  size?: 'default' | 'small';
}

const TONE_COLOR: Record<StatTone, string> = {
  default: '#5b6b66',
  primary: '#0f766e',
  success: '#1f8a4c',
  warning: '#d08700',
  danger: '#c0392b',
  info: '#2563a8',
};

export default function StatBadge({
  label,
  value,
  suffix = '',
  percent,
  tone = 'default',
  icon,
  hint,
  size = 'default',
}: StatBadgeProps) {
  const color = TONE_COLOR[tone];
  const body = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: size === 'small' ? 108 : 140,
        padding: size === 'small' ? '8px 10px' : '12px 14px',
        background: '#ffffff',
        border: '1px solid #e4ebe8',
        borderLeft: `4px solid ${color}`,
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#5b6b66', fontSize: 13 }}>
        {icon !== undefined ? <span style={{ color }}>{icon}</span> : null}
        <span>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: size === 'small' ? 18 : 22, fontWeight: 700, color: '#20302b' }}>{value}</span>
        {suffix !== '' ? <span style={{ fontSize: 12, color: '#7b8a85' }}>{suffix}</span> : null}
      </div>
      {percent !== undefined ? (
        <Progress
          percent={Math.max(0, Math.min(100, Math.round(percent * 10) / 10))}
          strokeColor={color}
          size="small"
          showInfo={false}
        />
      ) : null}
    </div>
  );
  if (hint === undefined) return body;
  return <Tooltip title={hint}>{body}</Tooltip>;
}
