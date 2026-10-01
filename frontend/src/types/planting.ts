/**
 * 栽植记录（Planting）
 * 一条栽植记录引用一个苗木批次，登记株距与株数。
 */

export interface Planting {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 消耗的苗木批次 */
  seedlingId: string;
  /** 栽植日期 YYYY-MM-DD */
  plantDate: string;
  /** 株距（米） */
  spacingM: number;
  /** 株数（株） */
  count: number;
  /** 作业班组 */
  operator: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑栽植记录的表单草稿 */
export interface PlantingDraft {
  plotId: string;
  seedlingId: string;
  plantDate: string;
  spacingM: number;
  count: number;
  operator: string;
}
