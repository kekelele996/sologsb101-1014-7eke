/**
 * 成活率派生 hook
 * 按地块与测次算成活率、株高增幅与补植建议；被验收台与补植计划页复用。
 */
import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import type { Survey, RateLevel } from '../types/survey';
import type { Planting } from '../types/planting';
import type { Substrate, TideZone } from '../types/plot';
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
  /** 该测次的成活率（%） */
  rate: number;
  /** 是否被人工复核过等级 */
  gradeManual: boolean;
  level: RateLevel;
  /** 该测次结论是否因地块立地条件变更而失效（潮位带 / 底质与当前不一致） */
  stale: boolean;
}

/** 单个地块的成活率派生汇总 */
export interface SurvivalSummary {
  plotId: string;
  /** 栽植总株数 */
  totalCount: number;
  /** 按测次排序的数据点 */
  points: SurvivalPoint[];
  /** 最新测次（含已失效） */
  latest: SurvivalPoint | null;
  /** 上一次测次（含已失效） */
  previous: SurvivalPoint | null;
  /** 最新有效测次（立地条件未变更） */
  latestValid: SurvivalPoint | null;
  /** 上一次有效测次 */
  previousValid: SurvivalPoint | null;
  /** 最新成活率（%）——取最新有效测次；无有效测次时为 0 */
  latestRate: number;
  /** 与上一有效测次的成活率差（百分点） */
  trend: number;
  /** 株高增幅（cm） */
  heightDelta: number;
  /** 株高增幅百分比（%） */
  heightPct: number;
  /** 建议补植株数 */
  suggestReplant: number;
  /** 最新有效等级 */
  level: RateLevel;
  /** 是否低于告警阈值 */
  warn: boolean;
  /** 是否存在因立地条件变更而失效的测次 */
  hasStale: boolean;
  /** 失效测次数 */
  staleCount: number;
}

/** 地块当前立地条件（潮位带 + 底质），用于判定验收测次结论是否失效 */
export interface PlotSite {
  tideZone: TideZone;
  substrate: Substrate;
}

/** 纯函数：由验收记录与栽植记录派生地块成活率汇总 */
export function buildSurvivalSummary(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
  site: PlotSite | null = null,
  threshold: number = SURVIVAL_WARN_RATE,
): SurvivalSummary {
  const totalCount = plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);

  const points: SurvivalPoint[] = surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round)
    .map((row) => {
      const rate = totalCount > 0 ? calcSurvivalRate(row.aliveCount, totalCount) : row.survivalRate;
      // 验收留底的潮位带 / 底质与地块当前立地条件不一致 → 该测次结论失效
      const stale =
        site !== null && (row.tideZone !== site.tideZone || row.substrate !== site.substrate);
      return {
        surveyId: row.id,
        round: row.round,
        date: row.date,
        aliveCount: row.aliveCount,
        avgHeightCm: row.avgHeightCm,
        rate,
        gradeManual: row.gradeManual,
        level: row.gradeManual ? row.grade : rateLevel(rate),
        stale,
      };
    });

  const latest = points.length > 0 ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;

  // 成活率结论只认「有效测次」：立地条件变更后，旧测次结论失效，需重新验收
  const validPoints = points.filter((point) => !point.stale);
  const latestValid = validPoints.length > 0 ? validPoints[validPoints.length - 1] : null;
  const previousValid = validPoints.length > 1 ? validPoints[validPoints.length - 2] : null;

  const growth = latestValid && previousValid ? heightGrowth(previousValid.avgHeightCm, latestValid.avgHeightCm) : { delta: 0, pct: 0 };

  return {
    plotId,
    totalCount,
    points,
    latest,
    previous,
    latestValid,
    previousValid,
    latestRate: latestValid ? latestValid.rate : 0,
    trend: latestValid && previousValid ? round1(latestValid.rate - previousValid.rate) : 0,
    heightDelta: growth.delta,
    heightPct: growth.pct,
    suggestReplant: latestValid ? suggestReplantCount(totalCount, latestValid.aliveCount) : totalCount,
    level: latestValid ? latestValid.level : 'poor',
    warn: latestValid !== null && latestValid.rate < threshold,
    hasStale: points.some((point) => point.stale),
    staleCount: points.filter((point) => point.stale).length,
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
  const [site, setSite] = useState<PlotSite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const subscription = liveQuery(async () => {
      await initDatabase();
      const [surveyRows, plantingRows, plot] = await Promise.all([
        db.surveys.toArray(),
        db.plantings.toArray(),
        plotId === null ? Promise.resolve(undefined) : db.plots.get(plotId),
      ]);
      return {
        surveyRows,
        plantingRows,
        site: plot ? { tideZone: plot.tideZone, substrate: plot.substrate } : null,
      };
    }).subscribe({
      next: ({ surveyRows, plantingRows, site: nextSite }) => {
        if (!active) return;
        setSurveys(surveyRows);
        setPlantings(plantingRows);
        setSite(nextSite);
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
  }, [plotId]);

  const summary = useMemo(
    () => (plotId === null ? emptySummary('') : buildSurvivalSummary(plotId, surveys, plantings, site, threshold)),
    [plotId, surveys, plantings, site, threshold],
  );

  return { summary, loading, error };
}
