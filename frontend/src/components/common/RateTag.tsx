/**
 * <RateTag> 成活率标签
 * 按成活率区间渲染底色与图标，被地块台账与验收台消费。
 */
import { Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { RATE_LEVEL_LABEL, type RateLevel } from '../../types/survey';
import { rateLevel } from '../../utils/rate';

export interface RateTagProps {
  /** 成活率（%）；null / undefined 表示暂无验收 */
  rate: number | null | undefined;
  /** 可覆盖自动判定的等级（人工复核结果） */
  level?: RateLevel;
  /** 是否被人工复核过 */
  manual?: boolean;
  suffix?: string;
  size?: 'default' | 'small';
}

const LEVEL_COLOR: Record<RateLevel, string> = {
  excellent: 'success',
  good: 'processing',
  fair: 'warning',
  poor: 'error',
};

const LEVEL_ICON: Record<RateLevel, typeof CheckCircleOutlined> = {
  excellent: CheckCircleOutlined,
  good: CheckCircleOutlined,
  fair: WarningOutlined,
  poor: CloseCircleOutlined,
};

const LEVEL_HINT: Record<RateLevel, string> = {
  excellent: '成活率 ≥ 85%，达到优秀水平',
  good: '成活率 70%–85%，长势良好',
  fair: '成活率 50%–70%，需加密监测',
  poor: '成活率 < 50%，必须生成补植计划',
};

export default function RateTag({ rate, level, manual = false, suffix = '', size = 'default' }: RateTagProps) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return (
      <Tag icon={<MinusCircleOutlined />} color="default">
        暂无验收
      </Tag>
    );
  }
  const resolved: RateLevel = level ?? rateLevel(rate);
  const Icon = LEVEL_ICON[resolved];
  return (
    <Tooltip title={`${LEVEL_HINT[resolved]}${manual ? '（等级经人工复核）' : ''}`}>
      <Tag
        icon={<Icon />}
        color={LEVEL_COLOR[resolved]}
        style={size === 'small' ? { fontSize: 12, lineHeight: '18px', margin: 0 } : undefined}
      >
        {rate.toFixed(1)}%{suffix}
        <span style={{ marginLeft: 6, opacity: 0.85 }}>{RATE_LEVEL_LABEL[resolved]}</span>
        {manual ? <span style={{ marginLeft: 4 }}>· 复核</span> : null}
      </Tag>
    </Tooltip>
  );
}
