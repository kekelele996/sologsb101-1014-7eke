/**
 * 成活率派生 hook
 * 按地块与测次算成活率、株高增幅与补植建议；被验收台与补植计划页复用。
 */
import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import type { Survey, RateLevel } from '../types/survey';
import type { Planting } from '../types/planting';
import { db, initDatabase } from '../utils/db';
import {
  SURVIVAL_WARN_RATE,
  calcSurvivalRate,
  heightGrowth,
  rateLevel,
  round1,
  suggestReplantCount,
} from '../utils/rate';

/** 单个测次的成活率数据点 */
export interface SurvivalPoint {
  surveyId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
  /** 该测次的成活率（%）——已定级测次取项目部确认值，未定级测次按当前栽植总株数派生 */
  rate: number;
  /** 是否被人工复核过等级 */
  gradeManual: boolean;
  level: RateLevel;
  /** 项目部是否已定级确认（定版后班组补植不得改写） */
  confirmed: boolean;
  /** 项目部定级确认日期 */
  confirmedDate: string;
  /** 成活率结论是否仍有效（地块潮位带 / 底质变更后失效） */
  conditionsValid: boolean;
  /** 失效原因 */
  invalidReason: string;
}

/** 单个地块的成活率派生汇总 */
export interface SurvivalSummary {
  plotId: string;
  /** 栽植总株数 */
  totalCount: number;
  /** 按测次排序的全部数据点（含因立地条件变更而失效的结论，便于留痕追溯） */
  points: SurvivalPoint[];
  /** 结论仍然有效的测次（失效的需重新验收） */
  validPoints: SurvivalPoint[];
  /** 失效结论数量 */
  invalidCount: number;
  /** 最新测次（只取结论仍有效的测次） */
  latest: SurvivalPoint | null;
  /** 上一次测次 */
  previous: SurvivalPoint | null;
  /** 最新成活率（%）——项目部已定级的结论不被班组补植带着改 */
  latestRate: number;
  /** 最新结论是否已经项目部定级确认 */
  latestConfirmed: boolean;
  /** 与上一测次的成活率差（百分点） */
  trend: number;
  /** 株高增幅（cm） */
  heightDelta: number;
  /** 株高增幅百分比（%） */
  heightPct: number;
  /** 建议补植株数 */
  suggestReplant: number;
  /** 最新等级 */
  level: RateLevel;
  /** 是否低于告警阈值 */
  warn: boolean;
}

/**
 * 纯函数：由验收记录与栽植记录派生地块成活率汇总。
 * 口径分离：
 * - 项目部已定级（confirmed）的测次：成活率 / 等级以项目部确认值为准，不随栽植株数重算；
 * - 未定级测次：按当前栽植总株数派生；
 * - 地块潮位带 / 底质变更后 conditionsValid=false 的结论不参与「最新」统计，须重新验收。
 */
export function buildSurvivalSummary(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
  threshold: number = SURVIVAL_WARN_RATE,
): SurvivalSummary {
  const totalCount = plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);

  const points: SurvivalPoint[] = surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round)
    .map((row) => {
      // 已定级测次锁定项目部确认值；未定级测次按当前栽植总株数派生
      const derived = totalCount > 0 ? calcSurvivalRate(row.aliveCount, totalCount) : row.survivalRate;
      const rate = row.confirmed ? row.survivalRate : derived;
      return {
        surveyId: row.id,
        round: row.round,
        date: row.date,
        aliveCount: row.aliveCount,
        avgHeightCm: row.avgHeightCm,
        rate,
        gradeManual: row.gradeManual,
        level: row.gradeManual || row.confirmed ? row.grade : rateLevel(rate),
        confirmed: row.confirmed,
        confirmedDate: row.confirmedDate ?? '',
        conditionsValid: row.conditionsValid ?? true,
        invalidReason: row.invalidReason ?? '',
      };
    });

  const validPoints = points.filter((point) => point.conditionsValid);
  const latest = validPoints.length > 0 ? validPoints[validPoints.length - 1] : null;
  const previous = validPoints.length > 1 ? validPoints[validPoints.length - 2] : null;
  const growth = latest && previous ? heightGrowth(previous.avgHeightCm, latest.avgHeightCm) : { delta: 0, pct: 0 };

  return {
    plotId,
    totalCount,
    points,
    validPoints,
    invalidCount: points.length - validPoints.length,
    latest,
    previous,
    latestRate: latest ? latest.rate : 0,
    latestConfirmed: latest ? latest.confirmed : false,
    trend: latest && previous ? round1(latest.rate - previous.rate) : 0,
    heightDelta: growth.delta,
    heightPct: growth.pct,
    suggestReplant: latest ? suggestReplantCount(totalCount, latest.aliveCount) : totalCount,
    level: latest ? latest.level : 'poor',
    warn: latest !== null && latest.rate < threshold,
  };
}

export interface UseSurvivalRateResult {
  summary: SurvivalSummary;
  loading: boolean;
  error: string;
}

/** 空汇总，用于地块不存在或尚无数据时兜底，避免页面白屏 */
export function emptySummary(plotId: string): SurvivalSummary {
  return buildSurvivalSummary(plotId, [], []);
}

/**
 * 订阅某地块的验收与栽植记录，实时派生成活率、株高增幅与补植建议。
 */
export function useSurvivalRate(plotId: string | null, threshold: number = SURVIVAL_WARN_RATE): UseSurvivalRateResult {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [plantings, setPlantings] = useState<Planting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const subscription = liveQuery(async () => {
      await initDatabase();
      const [surveyRows, plantingRows] = await Promise.all([db.surveys.toArray(), db.plantings.toArray()]);
      return { surveyRows, plantingRows };
    }).subscribe({
      next: ({ surveyRows, plantingRows }) => {
        if (!active) return;
        setSurveys(surveyRows);
        setPlantings(plantingRows);
        setError('');
        setLoading(false);
      },
      error: (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : '读取成活率数据失败');
        setLoading(false);
      },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const summary = useMemo(
    () => (plotId === null ? emptySummary('') : buildSurvivalSummary(plotId, surveys, plantings, threshold)),
    [plotId, surveys, plantings, threshold],
  );

  return { summary, loading, error };
}
