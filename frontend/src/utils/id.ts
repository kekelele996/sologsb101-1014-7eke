/** 主键与时间戳工具：所有实体 id 与 createdAt / updatedAt 都由此生成 */

/** 生成带前缀的短 id（时间戳 + 随机串），保证本地唯一且可读 */
export function uuid(prefix = 'row'): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${time}${rand}`;
}

/** 当前时间的 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 当前日期 YYYY-MM-DD */
export function today(): string {
  const date = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 文件名时间戳片段 */
export function stampSuffix(): string {
  const date = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
