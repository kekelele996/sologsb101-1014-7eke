/**
 * 补植计划（Replant）
 * 验收成活率偏低时生成的补植任务，完成后回写地块缺株数。
 */
import type { SeedlingSpecies } from './seedling';

/** 补植状态：待补植 / 已补植 / 已复核 */
export type ReplantState = '待补植' | '已补植' | '已复核';

/** 班组补植株数与项目部验收的对账状态：未对账 / 账实相符 / 对不上已挂起 */
export type ReconcileStatus = 'pending' | 'matched' | 'held';

export const REPLANT_STATE_OPTIONS: ReplantState[] = ['待补植', '已补植', '已复核'];

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  pending: '未对账',
  matched: '账实相符',
  held: '挂起待人定',
};

/** 补植状态流转顺序，用于「推进状态」动作 */
export const REPLANT_STATE_FLOW: ReplantState[] = ['待补植', '已补植', '已复核'];

export interface Replant {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 缺株数（株）——来自项目部验收口径，作为对账基准 */
  missingCount: number;
  /** 计划补植日期 YYYY-MM-DD */
  planDate: string;
  /** 补植树种 */
  species: SeedlingSpecies;
  /** 补植状态 */
  state: ReplantState;
  /** 班组现场记录的实际补植株数；未记录时为 null */
  crewActualCount: number | null;
  /** 班组补植完成日期 YYYY-MM-DD */
  completedDate: string;
  /** 班组株数与项目部验收口径的对账状态 */
  reconcileStatus: ReconcileStatus;
  /** 挂起 / 平账处理备注 */
  reconcileNote: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 班组现场记录补植完成的入参（只登记班组侧数据） */
export interface CrewCompletionDraft {
  /** 班组现场清点的实际补植株数 */
  actualCount: number;
  /** 补植完成日期 YYYY-MM-DD */
  completedDate: string;
}

/** 项目部重新验收（复核）入参——只有项目部重新验收才算数 */
export interface ProjectReviewDraft {
  /** 重新验收日期 YYYY-MM-DD */
  date: string;
  /** 重新验收成活株数 */
  aliveCount: number;
  /** 平均株高（厘米） */
  avgHeightCm: number;
}

/** 新建 / 编辑补植计划的表单草稿 */
export interface ReplantDraft {
  plotId: string;
  missingCount: number;
  planDate: string;
  species: SeedlingSpecies;
  state: ReplantState;
}
