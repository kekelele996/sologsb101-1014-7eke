/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantCompletionDraft, ReplantState } from '../types/replant';
import { rateLevel } from './rate';
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
    this.version(2)
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

    // ---------- v3：班组补植与项目验收两边分离，补齐对账与立地留底字段 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, reconcileState, species',
      })
      .upgrade(async (tx) => {
        const [plots, surveys, replants] = await Promise.all([
          tx.table('plots').toArray(),
          tx.table('surveys').toArray(),
          tx.table('replants').toArray(),
        ]);
        const plotMap = new Map<string, Plot>(plots.map((p) => [p.id, p]));

        // 迁移 4a：地块补齐缺株数、最近补植日期、班组最新测得成活率
        // （已有数据升级时补齐缺株数和最近补植日期；班组测得成活率取最近一次验收成活率兜底）
        const latestRateByPlot = new Map<string, number | null>();
        for (const plot of plots) {
          const plotSurveys = surveys
            .filter((s) => s.plotId === plot.id)
            .sort((a, b) => b.round - a.round);
          latestRateByPlot.set(plot.id, plotSurveys.length > 0 ? plotSurveys[0].survivalRate : null);
        }
        await tx.table('plots').bulkPut(
          plots.map((plot) => ({
            ...plot,
            missingCount: typeof plot.missingCount === 'number' ? plot.missingCount : 0,
            lastReplantDate: typeof plot.lastReplantDate === 'string' ? plot.lastReplantDate : '',
            latestMeasuredRate:
              typeof plot.latestMeasuredRate === 'number'
                ? plot.latestMeasuredRate
                : latestRateByPlot.get(plot.id) ?? null,
            revision: ROW_REVISION,
          })),
        );

        // 迁移 4b：验收记录补齐验收时的潮位带 / 底质留底（取地块当前立地条件）
        await tx.table('surveys').bulkPut(
          surveys.map((survey) => {
            const plot = plotMap.get(survey.plotId);
            return {
              ...survey,
              tideZone: typeof survey.tideZone === 'string' ? survey.tideZone : (plot?.tideZone ?? '中'),
              substrate: typeof survey.substrate === 'string' ? survey.substrate : (plot?.substrate ?? '淤泥质'),
              revision: ROW_REVISION,
            };
          }),
        );

        // 迁移 4c：补植计划补齐实际补植株数与对账字段
        // 历史已补植 / 已复核的计划视为已对账，待补植的视为未对账
        await tx.table('replants').bulkPut(
          replants.map((replant) => ({
            ...replant,
            actualCount: typeof replant.actualCount === 'number' ? replant.actualCount : replant.missingCount,
            reconcileState:
              typeof replant.reconcileState === 'string'
                ? replant.reconcileState
                : replant.state === '待补植'
                  ? '未对账'
                  : '已对账',
            reconcileNote: typeof replant.reconcileNote === 'string' ? replant.reconcileNote : '',
            reconciledAt: typeof replant.reconciledAt === 'string' ? replant.reconciledAt : '',
            reconciledSurveyId: typeof replant.reconciledSurveyId === 'string' ? replant.reconciledSurveyId : '',
            beforeAliveCount: typeof replant.beforeAliveCount === 'number' ? replant.beforeAliveCount : 0,
            revision: ROW_REVISION,
          })),
        );
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
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
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
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
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
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 班组补植完成回写（两边分离）：
 * 1）扣减地块缺株数（按实际补植株数）；2）写入最近补植日期；3）回写班组最新测得成活率。
 * 只动地块侧字段，绝不带着改项目部已定级的测次与等级——验收记录只有项目部重新验收才算数。
 * 同时记录实际补植株数与对账基准成活株数，状态置为「未对账」，等项目部新测次验收核销。
 */
export async function applyReplantCompletion(
  replantId: string,
  completion: ReplantCompletionDraft,
): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const actualCount = Math.max(0, Math.round(completion.actualCount || 0));
    // 对账基准：补植完成时项目部最新一次验收的成活株数
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    const beforeAlive = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc), { round: 0, aliveCount: 0 })
      .aliveCount;

    await db.plots.update(plot.id, {
      missingCount: Math.max(0, plot.missingCount - actualCount),
      lastReplantDate: today(),
      latestMeasuredRate: completion.measuredRate,
      updatedAt: nowIso(),
    });

    await db.replants.update(replant.id, {
      state: '已补植',
      actualCount,
      reconcileState: '未对账',
      reconcileNote: '',
      reconciledAt: '',
      reconciledSurveyId: '',
      beforeAliveCount: beforeAlive,
      updatedAt: nowIso(),
    });
  });
}

/**
 * 班组补植株数与项目部验收对账：
 * 项目部每录入一个新测次（重新验收）后触发，把该地块所有「已补植 + 未对账」的计划一起核销。
 * 规则：新测次成活株数 − 上一测次成活株数 ≥ 各计划实际补植株数之和 → 对得上（已对账）；
 * 否则对不上，先置为「挂起」等人核定，不自动改任何验收结论。
 */
export async function reconcileReplants(plotId: string, newSurveyId: string): Promise<void> {
  await db.transaction('rw', db.replants, db.surveys, async () => {
    const newSurvey = await db.surveys.get(newSurveyId);
    if (!newSurvey || newSurvey.plotId !== plotId) return;

    const pendings = await db.replants
      .where('plotId')
      .equals(plotId)
      .filter((row) => row.state === '已补植' && row.reconcileState === '未对账')
      .toArray();
    if (pendings.length === 0) return;

    // 对账基准：新测次之前最近一次验收的成活株数
    const prevSurveys = await db.surveys
      .where('plotId')
      .equals(plotId)
      .filter((row) => row.round < newSurvey.round)
      .toArray();
    const beforeAlive = prevSurveys.length > 0 ? prevSurveys.sort((a, b) => b.round - a.round)[0].aliveCount : 0;
    const expectedIncrease = pendings.reduce((acc, row) => acc + row.actualCount, 0);
    const actualIncrease = newSurvey.aliveCount - beforeAlive;
    const stamp = nowIso();

    if (actualIncrease >= expectedIncrease) {
      for (const row of pendings) {
        await db.replants.update(row.id, {
          reconcileState: '已对账',
          reconcileNote: '',
          reconciledAt: today(),
          reconciledSurveyId: newSurveyId,
          updatedAt: stamp,
        });
      }
      return;
    }

    // 对不上 → 挂起，等人定
    const note = `验收成活增加 ${actualIncrease} 株，与班组补植 ${expectedIncrease} 株不符（${beforeAlive} → ${newSurvey.aliveCount}），待人工核定`;
    for (const row of pendings) {
      await db.replants.update(row.id, {
        reconcileState: '挂起',
        reconcileNote: note,
        updatedAt: stamp,
      });
    }
  });
}

/** 人工核定：挂起的补植计划经人调查后确认对账一致，置为「已对账」（等人定） */
export async function resolveReconcile(replantId: string, note: string): Promise<void> {
  await db.replants.update(replantId, {
    reconcileState: '已对账',
    reconcileNote: note.trim() || '人工核定：验收成活与班组补植一致',
    reconciledAt: today(),
    updatedAt: nowIso(),
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核）；推进到「已补植」时触发回写（两边分离，不动验收记录） */
export async function advanceReplantState(
  replantId: string,
  next: ReplantState,
  completion?: ReplantCompletionDraft,
): Promise<void> {
  if (next === '已补植') {
    await applyReplantCompletion(replantId, completion ?? { actualCount: 0, measuredRate: null });
    return;
  }
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
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

/** 用快照覆盖整库（导入存档）；对旧版本存档补齐新字段，避免缺列 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
    // 旧版本存档（v2）可能缺少新字段，导入时补齐默认值
    const plots = snapshot.plots.map((row) => ({
      ...row,
      missingCount: typeof row.missingCount === 'number' ? row.missingCount : 0,
      lastReplantDate: typeof row.lastReplantDate === 'string' ? row.lastReplantDate : '',
      latestMeasuredRate: typeof row.latestMeasuredRate === 'number' ? row.latestMeasuredRate : null,
      revision: ROW_REVISION,
    }));
    const surveys = snapshot.surveys.map((row) => {
      const plot = plots.find((p) => p.id === row.plotId);
      return {
        ...row,
        tideZone: typeof row.tideZone === 'string' ? row.tideZone : (plot?.tideZone ?? '中'),
        substrate: typeof row.substrate === 'string' ? row.substrate : (plot?.substrate ?? '淤泥质'),
        revision: ROW_REVISION,
      };
    });
    const replants = snapshot.replants.map((row) => ({
      ...row,
      actualCount: typeof row.actualCount === 'number' ? row.actualCount : row.missingCount,
      reconcileState:
        typeof row.reconcileState === 'string'
          ? row.reconcileState
          : row.state === '待补植'
            ? '未对账'
            : '已对账',
      reconcileNote: typeof row.reconcileNote === 'string' ? row.reconcileNote : '',
      reconciledAt: typeof row.reconciledAt === 'string' ? row.reconciledAt : '',
      reconciledSurveyId: typeof row.reconciledSurveyId === 'string' ? row.reconciledSurveyId : '',
      beforeAliveCount: typeof row.beforeAliveCount === 'number' ? row.beforeAliveCount : 0,
      revision: ROW_REVISION,
    }));
    await db.plots.bulkPut(plots);
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(surveys);
    await db.replants.bulkPut(replants);
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
