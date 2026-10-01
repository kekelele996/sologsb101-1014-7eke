/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot, Substrate, TideZone } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { CrewCompletionDraft, ProjectReviewDraft, Replant } from '../types/replant';
import { calcSurvivalRate, crewRateAfterReplant, rateLevel } from './rate';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：班组 / 项目部两侧分离、对账挂起、立地条件失效 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // confirmed / conditionsValid 作为筛选索引：定级、失效结论都可快速过滤
        surveys: 'id, plotId, [plotId+round], date, grade, confirmed, conditionsValid',
        // reconcileStatus 索引：快速筛出对不上、挂起待人定的补植计划
        replants: 'id, plotId, planDate, state, species, reconcileStatus',
      })
      .upgrade(async (tx) => {
        // 先读出全部历史行（此时新字段都还缺），在内存里规范化后再统一写回
        const [plotRows, surveyRows, plantingRows, replantRows] = await Promise.all([
          tx.table('plots').toCollection().toArray(),
          tx.table('surveys').toCollection().toArray(),
          tx.table('plantings').toCollection().toArray(),
          tx.table('replants').toCollection().toArray(),
        ]);
        const asMap = <T,>(rows: T[]): Array<T & Record<string, unknown>> => rows as Array<T & Record<string, unknown>>;

        // 1）栽植总株数 / 最新测次成活株数（用于反推班组测得成活率）
        const plantedTotals = new Map<string, number>();
        for (const row of asMap(plantingRows)) {
          const plotId = String(row.plotId ?? '');
          plantedTotals.set(plotId, (plantedTotals.get(plotId) ?? 0) + (Number(row.count) || 0));
        }
        const latestSurveyAlive = new Map<string, { round: number; alive: number }>();
        for (const row of asMap(surveyRows)) {
          const plotId = String(row.plotId ?? '');
          const round = Number(row.round) || 0;
          const alive = Number(row.aliveCount) || 0;
          const prev = latestSurveyAlive.get(plotId);
          if (prev === undefined || round > prev.round) latestSurveyAlive.set(plotId, { round, alive });
        }

        // 2）补植计划补齐班组实补、对账挂起字段（先完成日期 / 株数规范化）
        for (const row of asMap(replantRows)) {
          const done = row.state === '已补植' || row.state === '已复核';
          if (typeof row.crewActualCount !== 'number') row.crewActualCount = null;
          if (typeof row.completedDate !== 'string') row.completedDate = '';
          if (typeof row.reconcileNote !== 'string') row.reconcileNote = '';
          // 已有数据升级：已经走到「已补植 / 已复核」的历史记录，视为班组已完成、账实相符
          if (typeof row.reconcileStatus !== 'string') row.reconcileStatus = done ? 'matched' : 'pending';
          if (done && row.crewActualCount === null && typeof row.missingCount === 'number') {
            row.crewActualCount = row.missingCount;
          }
          if (done && row.completedDate === '' && typeof row.planDate === 'string') {
            row.completedDate = row.planDate;
          }
        }
        // 2b）规范化完成后，再汇总每地块班组累计实补与最近补植日期
        const crewSumByPlot = new Map<string, number>();
        const crewLatestDate = new Map<string, string>();
        for (const row of asMap(replantRows)) {
          const done = row.state === '已补植' || row.state === '已复核';
          if (done && typeof row.crewActualCount === 'number') {
            const plotId = String(row.plotId ?? '');
            crewSumByPlot.set(plotId, (crewSumByPlot.get(plotId) ?? 0) + row.crewActualCount);
            if (typeof row.completedDate === 'string' && row.completedDate !== '') {
              const prev = crewLatestDate.get(plotId);
              if (prev === undefined || row.completedDate > prev) crewLatestDate.set(plotId, row.completedDate);
            }
          }
        }

        // 3）地块补齐缺株数、最近补植日期与班组侧字段（缺什么补什么，不覆盖已有值）
        for (const row of asMap(plotRows)) {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
          if (typeof row.crewReplantCount !== 'number') row.crewReplantCount = 0;
          if (typeof row.crewSurvivalRate !== 'number') row.crewSurvivalRate = 0;
          if (typeof row.crewRateDate !== 'string') row.crewRateDate = '';
          const plotId = String(row.id ?? '');
          const crewTotal = crewSumByPlot.get(plotId);
          if (crewTotal !== undefined && crewTotal > 0) {
            const total = plantedTotals.get(plotId) ?? 0;
            const alive = latestSurveyAlive.get(plotId)?.alive ?? 0;
            if ((Number(row.crewReplantCount) || 0) === 0) row.crewReplantCount = crewTotal;
            if ((Number(row.crewSurvivalRate) || 0) === 0) {
              row.crewSurvivalRate = crewRateAfterReplant(alive, crewTotal, total);
            }
            const fallbackDate = crewLatestDate.get(plotId) ?? (row.lastReplantDate as string);
            if (row.crewRateDate === '' && fallbackDate) row.crewRateDate = fallbackDate;
          }
        }

        // 4）验收记录补齐定级确认与立地条件有效性字段（历史结论默认未定级、仍有效）
        for (const row of asMap(surveyRows)) {
          if (typeof row.confirmed !== 'boolean') row.confirmed = false;
          if (typeof row.confirmedDate !== 'string') row.confirmedDate = '';
          if (typeof row.conditionsValid !== 'boolean') row.conditionsValid = true;
          if (typeof row.invalidReason !== 'string') row.invalidReason = '';
        }

        await Promise.all([
          tx.table('replants').bulkPut(replantRows),
          tx.table('plots').bulkPut(plotRows),
          tx.table('surveys').bulkPut(surveyRows),
        ]);
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.transaction('rw', db.plots, db.surveys, async () => {
    const prev = await db.plots.get(id);
    await db.plots.update(id, { ...patch, updatedAt: nowIso() });
    // 地块潮位带 / 底质变更后，引用该地块的成活率结论失效，须重新验收
    const conditionsChanged =
      prev !== undefined &&
      ((patch.tideZone !== undefined && patch.tideZone !== prev.tideZone) ||
        (patch.substrate !== undefined && patch.substrate !== prev.substrate));
    if (conditionsChanged) {
      const reason = buildInvalidReason(prev?.tideZone, prev?.substrate, patch);
      const stamp = nowIso();
      await db.surveys.where('plotId').equals(id).modify((survey: Survey) => {
        survey.conditionsValid = false;
        survey.invalidReason = reason;
        survey.updatedAt = stamp;
      });
    }
  });
}

/** 生成立地条件变更的失效原因文案 */
function buildInvalidReason(
  prevTide: TideZone | undefined,
  prevSubstrate: Substrate | undefined,
  patch: Partial<Plot>,
): string {
  const parts: string[] = [];
  if (patch.tideZone !== undefined && patch.tideZone !== prevTide) {
    parts.push(`潮位带由「${prevTide ?? '—'}」改为「${patch.tideZone}」`);
  }
  if (patch.substrate !== undefined && patch.substrate !== prevSubstrate) {
    parts.push(`底质由「${prevSubstrate ?? '—'}」改为「${patch.substrate}」`);
  }
  return `${parts.join('、')}，原成活率结论失效，须重新验收`;
}

/** 删除地块并级联清理其下苗木批次、栽植、验收与补植计划 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  // 新字段缺省值放在展开之前，已存在的值不被覆盖
  const defaults = { confirmed: false, confirmedDate: '', conditionsValid: true, invalidReason: '' };
  await db.surveys.put({
    ...defaults,
    ...row,
    grade,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  });
}

/** 项目部按测次定级确认（不改变实测数值，只锁定该测次的等级与结论） */
export async function confirmSurveys(ids: string[], date: string = today()): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({
      ...row,
      confirmed: true,
      confirmedDate: date,
      gradeManual: true,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }));
  if (next.length > 0) await db.surveys.bulkPut(next);
  return next.length;
}

/** 批量调整成活率等级（项目部定级：人工复核覆盖并锁定该测次） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const date = today();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({
      ...row,
      grade,
      gradeManual: true,
      confirmed: true,
      confirmedDate: date,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  const defaults = {
    crewActualCount: null,
    completedDate: '',
    reconcileStatus: 'pending' as const,
    reconcileNote: '',
  };
  await db.replants.put({
    ...defaults,
    ...row,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/** 班组补植登记结果，供页面给出对账提示 */
export interface CrewCompletionResult {
  /** 对账结论：matched 账实相符 / held 对不上已挂起 */
  reconcile: 'matched' | 'held';
  /** 项目部验收口径缺株数（对账基准） */
  expected: number;
  /** 班组现场实补株数 */
  actual: number;
  /** 班组侧最新测得成活率（%） */
  crewRate: number;
}

/** 挂起对账的人工处理方式：认可班组实补数平账 / 退回班组重报 */
export type ResolveHoldAction = 'accept' | 'return';

/**
 * 班组补植完成登记（班组侧唯一写路径）：
 * 1）只回写地块缺株数、最近补植日期与「班组实测最新成活率」；
 * 2）不触碰项目部任何验收测次——已定级的测次与等级不会被带着改，未定级的也不改；
 * 3）班组实植株数与项目部验收口径（missingCount）对账：
 *    - 相符 → 账实相符，状态推进为「已补植」，等待项目部重新验收；
 *    - 不符 → 挂起待人定，停在「待补植」，不得继续推进。
 */
export async function recordCrewCompletion(
  replantId: string,
  draft: CrewCompletionDraft,
): Promise<CrewCompletionResult | null> {
  return db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return null;
    if (replant.state === '已复核') throw new Error('该计划已由项目部重新验收定版，不能再登记班组补植');
    if (replant.state === '已补植' && replant.reconcileStatus === 'matched') {
      throw new Error('该计划已账实相符并等待项目部重新验收，不能重复登记班组补植');
    }
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return null;

    const actual = Math.max(0, Math.round(draft.actualCount));
    const matched = actual === replant.missingCount;

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    // 班组测得成活率以最新一「仍有效」的测次为底数；立地条件变更后的失效结论不用
    const latest = surveys
      .filter((item) => item.conditionsValid !== false)
      .reduce<Survey | undefined>(
        (acc, item) => (acc === undefined || item.round > acc.round ? item : acc),
        undefined,
      );
    const crewRate = latest ? crewRateAfterReplant(latest.aliveCount, actual, total) : 0;

    // 地块：仅回写班组侧字段
    await db.plots.update(plot.id, {
      missingCount: Math.max(0, plot.missingCount - actual),
      lastReplantDate: draft.completedDate,
      crewReplantCount: actual,
      crewSurvivalRate: crewRate,
      crewRateDate: draft.completedDate,
      updatedAt: nowIso(),
    });

    await db.replants.update(replant.id, {
      crewActualCount: actual,
      completedDate: draft.completedDate,
      reconcileStatus: matched ? 'matched' : 'held',
      reconcileNote: matched
        ? '班组实植株数与项目部验收口径相符，等待项目部重新验收'
        : `班组现场实补 ${actual} 株，与项目部验收缺株 ${replant.missingCount} 株不符，挂起待人定`,
      // 对不上时停在「待补植」挂起，不允许进入「已补植」
      state: matched ? '已补植' : '待补植',
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });

    // 注意：此处刻意不写 db.surveys——项目部按测次定的成活率与等级只有重新验收才能变。

    return {
      reconcile: matched ? 'matched' : 'held',
      expected: replant.missingCount,
      actual,
      crewRate,
    };
  });
}

/**
 * 挂起对账的人工裁决：
 * - accept：认可班组实补株数，按班组数平账，进入「已补植」等待项目部重新验收；
 * - return：退回班组重报，清空本次班组实补登记并恢复地块缺株数。
 */
export async function resolveReplantHold(
  replantId: string,
  action: ResolveHoldAction,
  note: string,
): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant || replant.reconcileStatus !== 'held') return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;
    const stamp = nowIso();

    if (action === 'accept') {
      // 以班组实补数作为双方认可口径平账；地块缺株数此前已按实补数扣减，无需再动
      await db.replants.update(replant.id, {
        missingCount: replant.crewActualCount ?? replant.missingCount,
        reconcileStatus: 'matched',
        state: '已补植',
        reconcileNote: note || '人工裁决：认可班组现场实补株数，予以平账',
        updatedAt: stamp,
        revision: ROW_REVISION,
      });
    } else {
      const restored = replant.crewActualCount ?? 0;
      await db.plots.update(plot.id, { missingCount: plot.missingCount + restored, updatedAt: stamp });
      await db.replants.update(replant.id, {
        crewActualCount: null,
        completedDate: '',
        reconcileStatus: 'pending',
        state: '待补植',
        reconcileNote: note || '人工裁决：退回班组重新清点补报',
        updatedAt: stamp,
        revision: ROW_REVISION,
      });
    }
  });
}

/**
 * 项目部重新验收（项目部侧写路径）：
 * 按新测次登记成活株数并当场定级确认，原各测次原样保留；
 * 仅当对账账实相符（matched）且班组已补植完成时才允许执行。
 */
export async function projectReviewReplant(
  replantId: string,
  draft: ProjectReviewDraft,
): Promise<Survey> {
  return db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) throw new Error('补植计划不存在');
    if (replant.state !== '已补植' || replant.reconcileStatus !== 'matched') {
      throw new Error('只有班组补植完成且对账相符的计划，才能由项目部重新验收');
    }
    const plot = await db.plots.get(replant.plotId);
    if (!plot) throw new Error('地块不存在');

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    const nextRound = surveys.reduce((max, item) => Math.max(max, item.round), 0) + 1;
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    const stamp = nowIso();
    const row: Survey = {
      id: `survey-${replantId}-review`,
      plotId: plot.id,
      round: nextRound,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
      grade: rateLevel(survivalRate),
      // 项目部当场定级确认：该测次此后不被班组补植改写
      gradeManual: true,
      confirmed: true,
      confirmedDate: draft.date,
      conditionsValid: true,
      invalidReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    // 固定 id 在重复提交时会覆盖同一条复核测次，避免「重复验收」产生脏数据
    await db.surveys.put(row);

    await db.replants.update(replant.id, {
      state: '已复核',
      reconcileStatus: 'matched',
      reconcileNote: `项目部已于 ${draft.date} 重新验收（第 ${nextRound} 测次，成活率 ${survivalRate}%）`,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    // 缺株数改以项目部最新验收口径为准
    await db.plots.update(plot.id, {
      missingCount: Math.max(0, total - draft.aliveCount),
      updatedAt: stamp,
    });
    return row;
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
  };
}

/** 用快照覆盖整库（导入存档），旧版本快照缺字段时在此统一补齐 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
    await db.plots.bulkPut(
      snapshot.plots.map((row) => ({
        ...{
          missingCount: 0,
          lastReplantDate: '',
          crewReplantCount: 0,
          crewSurvivalRate: 0,
          crewRateDate: '',
        },
        ...row,
        revision: ROW_REVISION,
      })),
    );
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(
      snapshot.surveys.map((row) => ({
        ...{
          confirmed: false,
          confirmedDate: '',
          conditionsValid: true,
          invalidReason: '',
        },
        ...row,
        grade: typeof row.grade === 'string' ? row.grade : rateLevel(row.survivalRate ?? 0),
        revision: ROW_REVISION,
      })),
    );
    await db.replants.bulkPut(
      snapshot.replants.map((row) => {
        const done = row.state === '已补植' || row.state === '已复核';
        return {
          ...{
            crewActualCount: done ? row.missingCount ?? null : null,
            completedDate: '',
            reconcileStatus: done ? ('matched' as const) : ('pending' as const),
            reconcileNote: '',
          },
          ...row,
          revision: ROW_REVISION,
        };
      }),
    );
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants };
}
