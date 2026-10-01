/**
 * Dexie 单表增删改查 + 响应式订阅封装（React 版）
 * 页面统一通过它读写 IndexedDB，避免组件内部直接触碰 Dexie 实例。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery, type Table } from 'dexie';
import { ROW_REVISION } from '../utils/db';
import { nowIso, uuid } from '../utils/id';

/** 所有持久化实体共有的行结构 */
export interface IdbRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新增记录入参：id / 时间戳 / 修订号由封装层补齐 */
export type NewRow<T extends IdbRow> = Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'revision'> & {
  id?: string;
};

export interface UseIdbTableResult<T extends IdbRow> {
  rows: T[];
  loading: boolean;
  /** 是否已完成首次载入：用于区分「数据为空」与「尚未读取」 */
  ready: boolean;
  error: string;
  refresh: () => Promise<void>;
  getById: (id: string) => Promise<T | undefined>;
  create: (payload: NewRow<T>, idPrefix?: string) => Promise<T>;
  update: (id: string, patch: Partial<T>) => Promise<void>;
  upsert: (row: T) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bulkPut: (rows: T[]) => Promise<void>;
  clear: () => Promise<void>;
}

export interface UseIdbTableOptions<T extends IdbRow> {
  /** 是否按 updatedAt 倒序，默认 true */
  sortByUpdatedAt?: boolean;
  onChange?: (rows: T[]) => void;
}

export function useIdbTable<T extends IdbRow>(
  table: Table<T, string>,
  options: UseIdbTableOptions<T> = {},
): UseIdbTableResult<T> {
  const { sortByUpdatedAt = true, onChange } = options;
  const tableRef = useRef(table);
  tableRef.current = table;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const applySort = useCallback(
    (list: T[]): T[] => {
      if (!sortByUpdatedAt) return [...list];
      return [...list].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    },
    [sortByUpdatedAt],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    const subscription = liveQuery(async () => applySort(await tableRef.current.toArray())).subscribe({
      next: (list) => {
        if (!active) return;
        setRows(list);
        setReady(true);
        setError('');
        setLoading(false);
        onChangeRef.current?.(list);
      },
      error: (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : '订阅本地数据失败');
        setLoading(false);
      },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [applySort]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const list = applySort(await tableRef.current.toArray());
      setRows(list);
      setReady(true);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取本地数据失败');
    } finally {
      setLoading(false);
    }
  }, [applySort]);

  const create = useCallback(async (payload: NewRow<T>, idPrefix = 'row'): Promise<T> => {
    const stamp = nowIso();
    const row = {
      ...(payload as object),
      id: payload.id ?? uuid(idPrefix),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    } as T;
    await tableRef.current.put(row);
    return row;
  }, []);

  const update = useCallback(async (id: string, patch: Partial<T>): Promise<void> => {
    await tableRef.current.update(id, { ...patch, updatedAt: nowIso() } as never);
  }, []);

  const upsert = useCallback(async (row: T): Promise<void> => {
    await tableRef.current.put({ ...row, updatedAt: nowIso() });
  }, []);

  const remove = useCallback(async (id: string): Promise<void> => {
    await tableRef.current.delete(id);
  }, []);

  const bulkPut = useCallback(async (list: T[]): Promise<void> => {
    await tableRef.current.bulkPut(list);
  }, []);

  const clear = useCallback(async (): Promise<void> => {
    await tableRef.current.clear();
  }, []);

  const getById = useCallback(async (id: string): Promise<T | undefined> => tableRef.current.get(id), []);

  return { rows, loading, ready, error, refresh, getById, create, update, upsert, remove, bulkPut, clear };
}
