/**
 * 补植计划（Replant）
 * 验收成活率偏低时生成的补植任务，完成后回写地块缺株数。
 */
import type { SeedlingSpecies } from './seedling';

/** 补植状态：待补植 / 已补植 / 已复核 */
export type ReplantState = '待补植' | '已补植' | '已复核';

export const REPLANT_STATE_OPTIONS: ReplantState[] = ['待补植', '已补植', '已复核'];

/** 补植状态流转顺序，用于「推进状态」动作 */
export const REPLANT_STATE_FLOW: ReplantState[] = ['待补植', '已补植', '已复核'];

/**
 * 对账状态（班组补植株数 ↔ 项目部验收）：
 * - 未对账：补植已完成，尚未等到项目部新测次验收核销；
 * - 已对账：项目部验收成活增量与班组补植株数对得上；
 * - 挂起：对不上，先挂起等人核定。
 */
export type ReplantReconcileState = '未对账' | '已对账' | '挂起';

export const REPLANT_RECONCILE_OPTIONS: ReplantReconcileState[] = ['未对账', '已对账', '挂起'];

export interface Replant {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 计划缺株数（株）——生成计划时的口径 */
  missingCount: number;
  /** 班组实际补植株数（株）——现场完成时回填，与计划缺株数区分 */
  actualCount: number;
  /** 计划补植日期 YYYY-MM-DD */
  planDate: string;
  /** 补植树种 */
  species: SeedlingSpecies;
  /** 补植状态 */
  state: ReplantState;
  /** 对账状态：未对账 / 已对账 / 挂起 */
  reconcileState: ReplantReconcileState;
  /** 对账备注（挂起原因 / 人工核定说明） */
  reconcileNote: string;
  /** 对账（核销）日期 YYYY-MM-DD */
  reconciledAt: string;
  /** 核销该补植的项目部验收测次 id */
  reconciledSurveyId: string;
  /** 补植完成时项目部最新验收的成活株数（对账基准） */
  beforeAliveCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑补植计划的表单草稿 */
export interface ReplantDraft {
  plotId: string;
  missingCount: number;
  planDate: string;
  species: SeedlingSpecies;
  state: ReplantState;
}

/** 班组补植完成回写表单：实际补植株数 + 现场测得成活率 */
export interface ReplantCompletionDraft {
  /** 实际补植株数 */
  actualCount: number;
  /** 班组现场测得成活率（%），允许为空表示未测 */
  measuredRate: number | null;
}
