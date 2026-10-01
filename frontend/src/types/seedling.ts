/**
 * 苗木批次（Seedling）
 * 一次进场的一批苗木，登记树种、来源、规格与数量。
 */

/** 树种：秋茄 / 桐花树 / 白骨壤 / 无瓣海桑 */
export type SeedlingSpecies = '秋茄' | '桐花树' | '白骨壤' | '无瓣海桑';

/** 来源：自育苗 / 外购 */
export type SeedlingSource = '自育苗' | '外购';

export const SEEDLING_SPECIES_OPTIONS: SeedlingSpecies[] = ['秋茄', '桐花树', '白骨壤', '无瓣海桑'];
export const SEEDLING_SOURCE_OPTIONS: SeedlingSource[] = ['自育苗', '外购'];

export interface Seedling {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 树种 */
  species: SeedlingSpecies;
  /** 来源 */
  source: SeedlingSource;
  /** 规格（如 50cm 裸根苗 / 40cm 营养袋苗） */
  spec: string;
  /** 数量（株） */
  quantity: number;
  /** 进场日期 YYYY-MM-DD */
  arrivalDate: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑苗木批次的表单草稿 */
export interface SeedlingDraft {
  plotId: string;
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: string;
}
