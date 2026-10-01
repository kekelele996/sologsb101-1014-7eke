/**
 * 修复地块（Plot）
 * 红树林修复项目的最小管理单元，按潮位带与底质区分立地条件。
 */

/** 潮位带：低 / 中 / 高 */
export type TideZone = '低' | '中' | '高';

/** 底质：淤泥质 / 砂质 / 砂泥质 */
export type Substrate = '淤泥质' | '砂质' | '砂泥质';

/** 修复方式：造林 / 补植 / 自然恢复 */
export type RestoreMode = '造林' | '补植' | '自然恢复';

/** 地块跟踪状态：跟踪中 / 已验收 */
export type PlotState = '跟踪中' | '已验收';

export const TIDE_ZONE_OPTIONS: TideZone[] = ['低', '中', '高'];
export const SUBSTRATE_OPTIONS: Substrate[] = ['淤泥质', '砂质', '砂泥质'];
export const RESTORE_MODE_OPTIONS: RestoreMode[] = ['造林', '补植', '自然恢复'];
export const PLOT_STATE_OPTIONS: PlotState[] = ['跟踪中', '已验收'];

export interface Plot {
  id: string;
  /** 地块名 */
  name: string;
  /** 面积（亩） */
  areaMu: number;
  /** 潮位带 */
  tideZone: TideZone;
  /** 底质 */
  substrate: Substrate;
  /** 修复方式 */
  restoreMode: RestoreMode;
  /** 跟踪状态 */
  state: PlotState;
  /** 缺株数（株）——补植完成后由此回写 */
  missingCount: number;
  /** 最近一次补植/复壮回写日期 */
  lastReplantDate: string;
  createdAt: string;
  updatedAt: string;
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number;
}

/** 新建 / 编辑地块时的表单草稿 */
export interface PlotDraft {
  name: string;
  areaMu: number;
  tideZone: TideZone;
  substrate: Substrate;
  restoreMode: RestoreMode;
  state: PlotState;
}
