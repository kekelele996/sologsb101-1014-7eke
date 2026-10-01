/**
 * 验证 v2 → v3 升级迁移：先用「旧结构」写入一批 v2 格式数据，
 * 再以当前版本（v3）打开同一 IndexedDB，检查字段回填是否完整。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

const DB_NAME = 'gbmangrove';

async function seedV2(): Promise<void> {
  const old = new Dexie(DB_NAME);
  old.version(1).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
    seedlings: 'id, plotId, species, source, arrivalDate',
    plantings: 'id, plotId, seedlingId, plantDate',
    surveys: 'id, plotId, round, date',
    replants: 'id, plotId, planDate, state',
  });
  old.version(2).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
    seedlings: 'id, plotId, species, source, arrivalDate, quantity',
    plantings: 'id, plotId, seedlingId, plantDate, spacingM',
    surveys: 'id, plotId, [plotId+round], date, grade',
    replants: 'id, plotId, planDate, state, species',
  });
  const stamp = '2025-01-01T00:00:00.000Z';
  await old.table('plots').bulkPut([
    // 缺 missingCount / lastReplantDate / 班组字段
    { id: 'p1', name: '旧地块一', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林', state: '跟踪中', createdAt: stamp, updatedAt: stamp, revision: 2 },
    // 已有缺株与补植日期
    { id: 'p2', name: '旧地块二', areaMu: 20, tideZone: '低', substrate: '砂质', restoreMode: '补植', state: '跟踪中', missingCount: 0, lastReplantDate: '2024-10-10', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.table('plantings').bulkPut([
    { id: 'pl1', plotId: 'p2', seedlingId: 's1', plantDate: '2024-04-01', spacingM: 1, count: 1000, operator: '班', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.table('surveys').bulkPut([
    // v2 有 grade / gradeManual，缺 confirmed / conditionsValid
    { id: 'sv1', plotId: 'p2', round: 1, date: '2024-07-01', aliveCount: 800, avgHeightCm: 50, survivalRate: 80, grade: 'good', gradeManual: false, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.table('replants').bulkPut([
    // 待补植：无班组数据
    { id: 'r1', plotId: 'p1', missingCount: 100, planDate: '2025-02-01', species: '秋茄', state: '待补植', createdAt: stamp, updatedAt: stamp, revision: 2 },
    // 已补植：历史完成记录，缺班组 / 对账字段
    { id: 'r2', plotId: 'p2', missingCount: 200, planDate: '2024-10-01', species: '白骨壤', state: '已补植', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.close();
}

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

async function main(): Promise<void> {
  await seedV2();

  // 以当前代码（v3）打开，触发 upgrade
  const { db } = await import('../src/utils/db');
  await db.open();

  console.log('\n[迁移] v2 → v3 字段回填');
  check('schemaVersion = 3', db.verno === 3, `实际 ${db.verno}`);

  const p1 = await db.plots.get('p1');
  check('旧地块一缺株数补 0', p1?.missingCount === 0);
  check('旧地块一最近补植日期补空串', p1?.lastReplantDate === '');
  check('旧地块一班组实补补 0', p1?.crewReplantCount === 0);
  check('旧地块一班组成活率补 0', p1?.crewSurvivalRate === 0);
  check('旧地块一班组测定日期补空串', p1?.crewRateDate === '');

  const p2 = await db.plots.get('p2');
  check('旧地块二保留缺株数 0', p2?.missingCount === 0);
  check('旧地块二保留最近补植日期', p2?.lastReplantDate === '2024-10-10');
  // 已补植 200 株、最新成活 800/1000 → (800+200)/1000 = 100%
  check('旧地块二反推班组实补 200', p2?.crewReplantCount === 200);
  check('旧地块二反推班组测得成活率 100%', p2?.crewSurvivalRate === 100, `实际 ${p2?.crewSurvivalRate}`);
  check('旧地块二班组测定日期取补植完成日期 2024-10-01', p2?.crewRateDate === '2024-10-01', JSON.stringify(p2));

  const sv1 = await db.surveys.get('sv1');
  check('历史验收补 confirmed=false', sv1?.confirmed === false);
  check('历史验收补 confirmedDate=""', sv1?.confirmedDate === '');
  check('历史验收补 conditionsValid=true', sv1?.conditionsValid === true);
  check('历史验收补 invalidReason=""', sv1?.invalidReason === '');
  check('历史验收保留 grade', sv1?.grade === 'good');

  const r1 = await db.replants.get('r1');
  check('待补植记录 → pending，无班组数据', r1?.reconcileStatus === 'pending' && r1?.crewActualCount === null);
  const r2 = await db.replants.get('r2');
  check('已补植记录 → matched，班组数反填 200', r2?.reconcileStatus === 'matched' && r2?.crewActualCount === 200);
  check('已补植记录完成日期兜底为计划日期 2024-10-01', r2?.completedDate === '2024-10-01');

  console.log(`\n${failures === 0 ? '🎉 迁移验证通过' : `⚠️ ${failures} 条断言失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
