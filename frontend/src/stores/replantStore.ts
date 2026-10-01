/**
 * 补植计划状态管理（Zustand）
 * 两侧分离：
 * - 班组侧：现场登记补植完成（recordCrewCompletion），只回写地块缺株数、最近补植日期
 *   与「班组实测最新成活率」，不触碰项目部任何已定级测次；实植株数与项目部验收口径
 *   对不上时自动挂起（held）待人定（resolveHold）。
 * - 项目部侧：账实相符后重新验收（projectReview），以新测次定级定版，旧测次原样保留。
 */
import { create } from 'zustand';
import type { Survey } from '../types/survey';
import type {
  CrewCompletionDraft,
  ProjectReviewDraft,
  Replant,
  ReplantDraft,
  ReplantState,
  ReconcileStatus,
} from '../types/replant';
import {
  db,
  exportSnapshot,
  importSnapshot,
  initDatabase,
  projectReviewReplant,
  putReplant,
  recordCrewCompletion,
  removeReplant,
  resetDatabase,
  resolveReplantHold,
  type CrewCompletionResult,
  type DatabaseSnapshot,
  type ResolveHoldAction,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { usePlotStore } from './plotStore';

/** 补植计划筛选条件 */
export interface ReplantFilters {
  plotId: string | 'all';
  state: ReplantState | 'all';
  reconcile: ReconcileStatus | 'all';
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
  /** 班组现场登记补植完成：对账相符自动进入「已补植」，对不上挂起待人定 */
  recordCrewCompletion: (replantId: string, draft: CrewCompletionDraft) => Promise<CrewCompletionResult | null>;
  /** 挂起对账的人工裁决：认可班组数平账 / 退回重报 */
  resolveHold: (replantId: string, action: ResolveHoldAction, note: string) => Promise<void>;
  /** 项目部重新验收：登记新测次并定级定版，推进到「已复核」 */
  projectReview: (replantId: string, draft: ProjectReviewDraft) => Promise<Survey>;
  setSelectedIds: (ids: string[]) => void;
  setReviewState: (state: ReplantState | 'all') => void;
  exportAll: () => Promise<DatabaseSnapshot>;
  importAll: (snapshot: DatabaseSnapshot) => Promise<void>;
  resetAll: () => Promise<void>;
}

const EMPTY_FILTERS: ReplantFilters = { plotId: 'all', state: 'all', reconcile: 'all', keyword: '' };

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
      planDate: draft.planDate,
      species: draft.species,
      state: draft.state,
      crewActualCount: null,
      completedDate: '',
      reconcileStatus: 'pending',
      reconcileNote: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
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

  async recordCrewCompletion(replantId, draft) {
    const existing = await db.replants.get(replantId);
    if (!existing) return null;
    if (existing.state === '已复核') return null;
    if (existing.reconcileStatus === 'held') {
      throw new Error('该计划对不上已挂起，请先由项目部 / 负责人裁决后再登记');
    }
    const result = await recordCrewCompletion(replantId, draft);
    await usePlotStore.getState().refreshCounts();
    if (result === null) return null;
    if (result.reconcile === 'held') {
      set({
        revision: get().revision + 1,
        lastMessage: `班组实补 ${result.actual} 株与项目部验收缺株 ${result.expected} 株不符，已挂起待人定`,
      });
    } else {
      set({
        revision: get().revision + 1,
        lastMessage: `班组补植 ${result.actual} 株已登记，班组测得最新成活率 ${result.crewRate}%；已定级测次未改动，等待项目部重新验收`,
      });
    }
    return result;
  },

  async resolveHold(replantId, action, note) {
    await resolveReplantHold(replantId, action, note);
    await usePlotStore.getState().refreshCounts();
    set({
      revision: get().revision + 1,
      lastMessage:
        action === 'accept' ? '已按班组实补株数平账，可由项目部重新验收' : '已退回班组重新清点补报',
    });
  },

  async projectReview(replantId, draft) {
    // 项目部重新验收：新测次定级定版，旧测次与等级原样保留
    const row = await projectReviewReplant(replantId, draft);
    await usePlotStore.getState().refreshCounts();
    set({
      revision: get().revision + 1,
      lastMessage: `项目部已按第 ${row.round} 测次重新验收，成活率 ${row.survivalRate}%，等级已定版`,
    });
    return row;
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
