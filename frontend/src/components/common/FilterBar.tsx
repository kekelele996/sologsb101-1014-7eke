/**
 * <FilterBar> 关键字 + 多选条件过滤条
 * 筛选条件通过 URL query 同步（可分享、可刷新保持），被地块台账、栽植记录页、补植计划页消费。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Card, Input, Select, Space, Tag } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';

export interface FilterField {
  /** 同时作为 URL query 参数名 */
  key: string;
  label: string;
  options: string[];
  /** 选项展示名（可选） */
  optionLabels?: Record<string, string>;
}

export interface FilterBarProps {
  keyword: string;
  onKeywordChange: (value: string) => void;
  fields?: FilterField[];
  /** 当前值；'all' 表示不过滤 */
  values?: Record<string, string>;
  onChange?: (key: string, value: string) => void;
  onReset: () => void;
  resultText?: string;
  extra?: ReactNode;
}

export default function FilterBar({
  keyword,
  onKeywordChange,
  fields = [],
  values = {},
  onChange,
  onReset,
  resultText,
  extra,
}: FilterBarProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const hydrated = useRef(false);

  // 首次挂载：从 URL query 回灌筛选条件（支持把带筛选的链接直接分享出去）
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const queryKeyword = searchParams.get('q');
    if (queryKeyword !== null) onKeywordChange(queryKeyword);
    fields.forEach((field) => {
      const value = searchParams.get(field.key);
      if (value !== null) onChange?.(field.key, value);
    });
    // 只在首次挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 筛选条件变化后写回 URL query
  const serialized = JSON.stringify({ q: keyword, values });
  useEffect(() => {
    const next = new URLSearchParams();
    if (keyword.trim() !== '') next.set('q', keyword.trim());
    Object.entries(values).forEach(([key, value]) => {
      if (value !== '' && value !== 'all') next.set(key, value);
    });
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  return (
    <Card size="small" style={{ marginBottom: 14, background: '#fbfdfc' }}>
      <Space size={12} wrap>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="输入关键字筛选"
          style={{ width: 220 }}
          value={keyword}
          onChange={(event) => onKeywordChange(event.target.value)}
        />
        {fields.map((field) => (
          <Space key={field.key} size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>{field.label}</span>
            <Select
              size="middle"
              style={{ minWidth: 132 }}
              value={values[field.key] ?? 'all'}
              onChange={(value: string) => onChange?.(field.key, value)}
              options={[
                { value: 'all', label: `全部${field.label}` },
                ...field.options.map((option) => ({
                  value: option,
                  label: field.optionLabels?.[option] ?? option,
                })),
              ]}
            />
          </Space>
        ))}
        <Button icon={<ReloadOutlined />} onClick={onReset}>
          重置筛选
        </Button>
        {resultText !== undefined ? <Tag color="cyan">{resultText}</Tag> : null}
        {extra}
      </Space>
    </Card>
  );
}
