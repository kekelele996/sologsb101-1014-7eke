/**
 * 验收状态管理（Zustand）
 * 维护验收筛选条件、批量选中的记录与成活率等级草稿；
 * 成活率派生值统一由 hooks/useSurvivalRate 的纯函数产出，避免口径分散。
 */
import { create } from 'zustand';
import { RATE_LEVEL_LABEL, type RateLevel, type Survey, type SurveyDraft } from '../types/survey';
import {
  confirmSurveys,
  db,
  initDatabase,
  patchSurveyGrades,
  putSurvey,
  removeSurvey,
} from '../utils/db';
import type { SurvivalSummary } from '../hooks/useSurvivalRate';
import { nowIso, today, uuid } from '../utils/id';
import { calcSurvivalRate, rateLevel } from '../utils/rate';
import { usePlotStore } from './plotStore';

/** 验收筛选条件（地块 + 等级 + 关键字 + 日期区间） */
export interface SurveyFilters {
  plotId: string | 'all';
  level: RateLevel | 'all';
  keyword: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: SurveyFilters = { plotId: 'all', level: 'all', keyword: '', from: '', to: '' };

interface SurveyStoreState {
  filters: SurveyFilters;
  /** 批量操作选中的验收记录 id */
  selectedIds: string[];
  /** 批量调整使用的目标等级 */
  gradeDraft: RateLevel;
  /** 每次写操作后的版本号，页面据此重新拉取列表 */
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  setFilters: (patch: Partial<SurveyFilters>) => void;
  resetFilters: () => void;
  setSelectedIds: (ids: string[]) => void;
  setGradeDraft: (level: RateLevel) => void;
  createSurvey: (draft: SurveyDraft) => Promise<Survey>;
  updateSurvey: (surveyId: string, draft: SurveyDraft) => Promise<void>;
  deleteSurvey: (surveyId: string) => Promise<void>;
  /** 批量调整成活率等级（项目部定级，调整后即定版锁定） */
  bulkApplyGrade: (level: RateLevel) => Promise<number>;
  /** 项目部按测次定级确认（保持实测数值不变，只锁定该测次结论） */
  confirmRounds: (ids: string[]) => Promise<number>;
  /** 按最新测次生成补植计划（回写地块缺株数） */
  generateReplant: (plotId: string) => Promise<string>;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  rateStats: () => { total: number; warnCount: number; avgRate: number };
}

function totalPlantedOf(plotId: string): number {
  return usePlotStore
    .getState()
    .plantings.filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);
}

export const useSurveyStore = create<SurveyStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  selectedIds: [],
  gradeDraft: 'good',
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setGradeDraft(level) {
    set({ gradeDraft: level });
  },

  async createSurvey(draft) {
    const total = totalPlantedOf(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    const stamp = nowIso();
    const row: Survey = {
      id: uuid('survey'),
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
      grade: rateLevel(survivalRate),
      gradeManual: false,
      confirmed: false,
      confirmedDate: '',
      conditionsValid: true,
      invalidReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSurvey(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async updateSurvey(surveyId, draft) {
    const existing = await db.surveys.get(surveyId);
    if (!existing) return;
    // 项目部已定级的测次和等级不能被带着改：只有项目部重新验收（新测次）才算数
    if (existing.confirmed) {
      throw new Error(`第 ${existing.round} 测次已经项目部定级定版，如需调整请重新验收录入新测次`);
    }
    // 立地条件已变更、结论失效的测次只能留痕，不再就地修改
    if (existing.conditionsValid === false) {
      throw new Error('该地块潮位带 / 底质已变更，原测次结论已失效，请重新验收录入新测次');
    }
    const total = totalPlantedOf(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    await putSurvey({
      ...existing,
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
      // 未定级测次仍按数值自动判定，不得保留人工等级
      gradeManual: false,
      confirmed: false,
      confirmedDate: '',
      conditionsValid: true,
      invalidReason: '',
    });
    set({ revision: get().revision + 1 });
  },

  async deleteSurvey(surveyId) {
    await removeSurvey(surveyId);
    set({ selectedIds: get().selectedIds.filter((id) => id !== surveyId), revision: get().revision + 1 });
  },

  async bulkApplyGrade(level) {
    const ids = get().selectedIds;
    if (ids.length === 0) return 0;
    // 人工复核只改写等级标注，不改写实测成活率数值，保证数据可追溯；定级后即锁定
    await patchSurveyGrades(ids, level);
    set({ revision: get().revision + 1, lastMessage: `已按项目部定级调整 ${ids.length} 条验收记录为「${RATE_LEVEL_LABEL[level]}」并锁定测次` });
    return ids.length;
  },

  async confirmRounds(ids) {
    const count = await confirmSurveys(ids, today());
    if (count > 0) {
      set({ revision: get().revision + 1, lastMessage: `已按项目部定级确认 ${count} 个测次，班组补植不得再改写这些测次` });
    }
    return count;
  },

  async generateReplant(plotId) {
    const summary = get().summaryOf(plotId);
    const plot = usePlotStore.getState().plots.find((row) => row.id === plotId);
    if (!plot) return '地块不存在，无法生成补植计划';
    const missing = summary.suggestReplant;
    if (missing <= 0) return '该地块当前无缺株，无需生成补植计划';
    const species = usePlotStore.getState().seedlings.find((row) => row.plotId === plotId)?.species ?? '秋茄';
    const stamp = nowIso();
    await db.replants.put({
      id: uuid('replant'),
      plotId,
      missingCount: missing,
      planDate: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      species,
      state: '待补植',
      crewActualCount: null,
      completedDate: '',
      reconcileStatus: 'pending',
      reconcileNote: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    });
    set({ revision: get().revision + 1, lastMessage: `已为「${plot.name}」生成补植计划：缺株 ${missing} 株` });
    return `已生成补植计划：缺株 ${missing} 株`;
  },

  summaryOf(plotId) {
    return usePlotStore.getState().summaryOf(plotId);
  },

  rateStats() {
    const { summaries } = usePlotStore.getState();
    const list = Object.values(summaries);
    const withSurvey = list.filter((item) => item.latest !== null);
    if (withSurvey.length === 0) return { total: 0, warnCount: 0, avgRate: 0 };
    const sum = withSurvey.reduce((acc, item) => acc + item.latestRate, 0);
    return {
      total: withSurvey.length,
      warnCount: withSurvey.filter((item) => item.warn).length,
      avgRate: Math.round((sum / withSurvey.length) * 10) / 10,
    };
  },
}));
