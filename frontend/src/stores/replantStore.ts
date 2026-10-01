/**
 * 补植计划状态管理（Zustand）
 * 维护补植计划的行内草稿、复核状态与批量选中项；
 * 状态推进与「补植完成回写地块缺株数」也在这里统一收口。
 */
import { create } from 'zustand';
import type { Replant, ReplantCompletionDraft, ReplantDraft, ReplantState } from '../types/replant';
import {
  advanceReplantState,
  db,
  exportSnapshot,
  importSnapshot,
  initDatabase,
  putReplant,
  removeReplant,
  resetDatabase,
  resolveReconcile,
  ROW_REVISION,
  type DatabaseSnapshot,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { usePlotStore } from './plotStore';

/** 补植计划筛选条件 */
export interface ReplantFilters {
  plotId: string | 'all';
  state: ReplantState | 'all';
  keyword: string;
}

export interface ReplantStoreState {
  filters: ReplantFilters;
  /** 每行的行内编辑草稿，key = replant id */
  drafts: Record<string, Partial<ReplantDraft>>;
  /** 当前复核选中的状态（用于批量推进） */
  reviewState: ReplantState | 'all';
  selectedIds: string[];
  lastMessage: string;
  revision: number;
  init: () => Promise<void>;
  setFilters: (patch: Partial<ReplantFilters>) => void;
  resetFilters: () => void;
  setDraft: (replantId: string, patch: Partial<ReplantDraft>) => void;
  clearDraft: (replantId: string) => void;
  hasDraft: (replantId: string) => boolean;
  saveDraft: (replantId: string) => Promise<void>;
  createReplant: (draft: ReplantDraft) => Promise<Replant>;
  deleteReplant: (replantId: string) => Promise<void>;
  /** 推进到下一状态；进入「已补植」时按回写单回写地块缺株数与班组测得成活率（不动验收记录） */
  advance: (replantId: string, completion?: ReplantCompletionDraft) => Promise<ReplantState | null>;
  setState: (replantId: string, state: ReplantState) => Promise<void>;
  /** 人工核定挂起的补植计划（等人定）：确认对账一致后置为已对账 */
  resolveReconcile: (replantId: string, note: string) => Promise<void>;
  batchAdvance: () => Promise<number>;
  setSelectedIds: (ids: string[]) => void;
  setReviewState: (state: ReplantState | 'all') => void;
  exportAll: () => Promise<DatabaseSnapshot>;
  importAll: (snapshot: DatabaseSnapshot) => Promise<void>;
  resetAll: () => Promise<void>;
}

const EMPTY_FILTERS: ReplantFilters = { plotId: 'all', state: 'all', keyword: '' };
const FLOW: ReplantState[] = ['待补植', '已补植', '已复核'];

export const useReplantStore = create<ReplantStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  drafts: {},
  reviewState: 'all',
  selectedIds: [],
  lastMessage: '',
  revision: 0,

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

  setDraft(replantId, patch) {
    set({ drafts: { ...get().drafts, [replantId]: { ...get().drafts[replantId], ...patch } } });
  },

  clearDraft(replantId) {
    const next = { ...get().drafts };
    delete next[replantId];
    set({ drafts: next });
  },

  hasDraft(replantId) {
    return get().drafts[replantId] !== undefined;
  },

  async saveDraft(replantId) {
    const draft = get().drafts[replantId];
    if (draft === undefined) return;
    const existing = await db.replants.get(replantId);
    if (!existing) return;
    await putReplant({ ...existing, ...draft } as Replant);
    get().clearDraft(replantId);
    set({ revision: get().revision + 1, lastMessage: '草稿已保存到补植计划' });
  },

  async createReplant(draft) {
    const stamp = nowIso();
    const row: Replant = {
      id: uuid('replant'),
      plotId: draft.plotId,
      missingCount: draft.missingCount,
      // 新计划按计划缺株数作为实际补植株数默认值，待现场完成时回填
      actualCount: draft.missingCount,
      planDate: draft.planDate,
      species: draft.species,
      state: draft.state,
      reconcileState: '未对账',
      reconcileNote: '',
      reconciledAt: '',
      reconciledSurveyId: '',
      beforeAliveCount: 0,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putReplant(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async deleteReplant(replantId) {
    await removeReplant(replantId);
    get().clearDraft(replantId);
    set({
      selectedIds: get().selectedIds.filter((id) => id !== replantId),
      revision: get().revision + 1,
    });
  },

  async advance(replantId, completion) {
    const existing = await db.replants.get(replantId);
    if (!existing) return null;
    const index = FLOW.indexOf(existing.state);
    if (index < 0 || index >= FLOW.length - 1) return null;
    const next = FLOW[index + 1];
    await advanceReplantState(replantId, next, completion);
    await usePlotStore.getState().refreshCounts();
    set({
      revision: get().revision + 1,
      lastMessage:
        next === '已补植'
          ? '已标记补植完成：地块缺株数与班组测得成活率已回写（项目部验收测次与等级保持不变）'
          : `状态已推进为「${next}」`,
    });
    return next;
  },

  async setState(replantId, state) {
    await advanceReplantState(replantId, state);
    set({ revision: get().revision + 1 });
  },

  async resolveReconcile(replantId, note) {
    await resolveReconcile(replantId, note);
    set({ revision: get().revision + 1, lastMessage: '已人工核定对账结果' });
  },

  async batchAdvance() {
    const ids = get().selectedIds;
    let count = 0;
    for (const id of ids) {
      const next = await get().advance(id);
      if (next !== null) count += 1;
    }
    set({ selectedIds: [], lastMessage: `已批量推进 ${count} 条补植计划` });
    return count;
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setReviewState(state) {
    set({ reviewState: state });
  },

  async exportAll() {
    return exportSnapshot();
  },

  async importAll(snapshot) {
    await importSnapshot(snapshot);
    set({ revision: get().revision + 1 });
  },

  async resetAll() {
    await resetDatabase();
    set({ drafts: {}, selectedIds: [], revision: get().revision + 1 });
  },
}));
