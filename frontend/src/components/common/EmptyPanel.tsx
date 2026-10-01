/**
 * <EmptyPanel> 空数据引导与新建入口
 * 被全部列表页复用；地块/作品等层级路由查不到 id 时也用它兜底，避免白屏。
 */
import type { ReactNode } from 'react';
import { Button, Empty } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

export interface EmptyPanelProps {
  title: string;
  description?: string;
  actionText?: string;
  onAction?: () => void;
  extra?: ReactNode;
  icon?: ReactNode;
}

export default function EmptyPanel({
  title,
  description,
  actionText,
  onAction,
  extra,
  icon,
}: EmptyPanelProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '32px 16px',
        background: '#ffffff',
        border: '1px dashed #cfe0da',
        borderRadius: 12,
      }}
    >
      <Empty
        image={icon ?? Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div style={{ maxWidth: 460 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#20302b' }}>{title}</div>
            {description !== undefined ? (
              <div style={{ marginTop: 6, fontSize: 13, color: '#7b8a85', lineHeight: 1.7 }}>{description}</div>
            ) : null}
          </div>
        }
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {actionText !== undefined && onAction !== undefined ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={onAction}>
            {actionText}
          </Button>
        ) : null}
        {extra}
      </div>
    </div>
  );
}
