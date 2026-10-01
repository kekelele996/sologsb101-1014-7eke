/**
 * 导出工具：整库 JSON 存档、地块成活率 CSV、文本复制
 * 全部在浏览器本地完成，不经过任何服务端。
 */
import type { DatabaseSnapshot } from './db';
import { DB_NAME, DB_SCHEMA_VERSION } from './db';
import type { Plot } from '../types/plot';
import type { Survey } from '../types/survey';
import type { Planting } from '../types/planting';
import type { Seedling } from '../types/seedling';
import type { Replant } from '../types/replant';
import { RATE_LEVEL_LABEL } from '../types/survey';
import { calcSurvivalRate, percentText, round1 } from './rate';
import { stampSuffix } from './id';

/** 触发浏览器下载 */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** CSV 单元格转义 */
export function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出整库 JSON 存档，返回文件名 */
export function exportSnapshotJson(snapshot: DatabaseSnapshot): string {
  const filename = `${DB_NAME}-backup-${stampSuffix()}.json`;
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8');
  return filename;
}

export interface SnapshotParseResult {
  ok: boolean;
  message: string;
  snapshot: DatabaseSnapshot | null;
}

/** 解析并校验导入的 JSON 存档 */
export function parseSnapshot(text: string): SnapshotParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认文件内容完整。', snapshot: null };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '存档格式不正确：顶层必须是对象。', snapshot: null };
  }
  const data = raw as Partial<DatabaseSnapshot>;
  if (data.name !== DB_NAME) {
    return { ok: false, message: `存档不属于本项目：期望 name = ${DB_NAME}，实际为 ${String(data.name)}。`, snapshot: null };
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > DB_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `存档数据结构版本不兼容：当前支持 ≤ v${DB_SCHEMA_VERSION}，实际为 v${String(data.schemaVersion)}。`,
      snapshot: null,
    };
  }
  const collections: Array<keyof DatabaseSnapshot> = ['plots', 'seedlings', 'plantings', 'surveys', 'replants'];
  for (const key of collections) {
    if (!Array.isArray(data[key])) {
      return { ok: false, message: `存档缺少 ${String(key)} 数组。`, snapshot: null };
    }
  }
  return { ok: true, message: '存档校验通过。', snapshot: data as DatabaseSnapshot };
}

/** 导出全部地块的成活率汇总 CSV */
export function exportSummaryCsv(
  plots: Plot[],
  seedlings: Seedling[],
  plantings: Planting[],
  surveys: Survey[],
  replants: Replant[],
): string {
  const header = [
    '地块名',
    '面积(亩)',
    '潮位带',
    '底质',
    '修复方式',
    '状态',
    '苗木批次数',
    '进场苗木合计(株)',
    '栽植总株数(株)',
    '测次数',
    '最新测次',
    '最新成活株数',
    '最新成活率(%)',
    '判定等级',
    '平均株高(cm)',
    '缺株数(株)',
    '补植计划数',
    '最近补植日期',
  ];
  const lines: string[] = [header.map(csvCell).join(',')];
  plots.forEach((plot) => {
    const plotSeedlings = seedlings.filter((row) => row.plotId === plot.id);
    const plotPlantings = plantings.filter((row) => row.plotId === plot.id);
    const plotSurveys = surveys.filter((row) => row.plotId === plot.id).sort((a, b) => a.round - b.round);
    const plotReplants = replants.filter((row) => row.plotId === plot.id);
    const total = plotPlantings.reduce((acc, row) => acc + row.count, 0);
    const latest = plotSurveys.length > 0 ? plotSurveys[plotSurveys.length - 1] : null;
    const rate = latest ? calcSurvivalRate(latest.aliveCount, total) : 0;
    lines.push(
      [
        plot.name,
        plot.areaMu,
        plot.tideZone,
        plot.substrate,
        plot.restoreMode,
        plot.state,
        plotSeedlings.length,
        plotSeedlings.reduce((acc, row) => acc + row.quantity, 0),
        total,
        plotSurveys.length,
        latest ? `第 ${latest.round} 测次` : '未验收',
        latest ? latest.aliveCount : 0,
        round1(rate),
        latest ? RATE_LEVEL_LABEL[latest.grade] : '—',
        latest ? latest.avgHeightCm : 0,
        plot.missingCount,
        plotReplants.length,
        plot.lastReplantDate || '—',
      ]
        .map(csvCell)
        .join(','),
    );
  });
  return `\uFEFF${lines.join('\n')}`;
}

/** 导出成活率汇总 CSV 文件 */
export function exportSummaryCsvFile(
  plots: Plot[],
  seedlings: Seedling[],
  plantings: Planting[],
  surveys: Survey[],
  replants: Replant[],
): string {
  const filename = `红树林成活率汇总-${stampSuffix()}.csv`;
  download(filename, exportSummaryCsv(plots, seedlings, plantings, surveys, replants), 'text/csv;charset=utf-8');
  return filename;
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** 生成可复制的成活率通报纯文本 */
export function buildSummaryText(
  plots: Plot[],
  plantings: Planting[],
  surveys: Survey[],
  replants: Replant[],
): string {
  const lines: string[] = [`【红树林修复成活率通报】共 ${plots.length} 个地块`];
  plots.forEach((plot) => {
    const total = plantings.filter((row) => row.plotId === plot.id).reduce((acc, row) => acc + row.count, 0);
    const plotSurveys = surveys.filter((row) => row.plotId === plot.id).sort((a, b) => a.round - b.round);
    const latest = plotSurveys.length > 0 ? plotSurveys[plotSurveys.length - 1] : null;
    const rate = latest ? calcSurvivalRate(latest.aliveCount, total) : 0;
    const pending = replants.filter((row) => row.plotId === plot.id && row.state !== '已复核').length;
    lines.push(
      `· ${plot.name}（${plot.tideZone}潮位带 / ${plot.substrate}）栽植 ${total} 株，最新成活率 ${
        latest ? percentText(rate) : '未验收'
      }，缺株 ${plot.missingCount} 株，待办补植 ${pending} 条`,
    );
  });
  return lines.join('\n');
}
