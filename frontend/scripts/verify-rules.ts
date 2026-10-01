/**
 * 核心业务规则验证（Node + fake-indexeddb），不进 UI。
 * 运行：npx tsx scripts/verify-rules.ts —— 这里用 esbuild 即时编译。
 */
import 'fake-indexeddb/auto';
import {
  db,
  recordCrewCompletion,
  resolveReplantHold,
  projectReviewReplant,
  patchPlot,
  confirmSurveys,
  resetDatabase,
  initDatabase,
} from '../src/utils/db';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

async function main(): Promise<void> {
  await initDatabase();
  await resetDatabase();

  const plotA = 'plot-donggang-3';
  const plotB = 'plot-xiwan-a';
  const plotC = 'plot-beiyu-b';

  console.log('\n[1] 播种数据：已定级测次 / 班组已补 / 对账挂起');
  const b1 = await db.surveys.get('survey-b1');
  const c1 = await db.surveys.get('survey-c1');
  const c3 = await db.surveys.get('survey-c3');
  check('西湾第 1 测次已定版', b1?.confirmed === true);
  check('北屿第 1 测次未定级', c1?.confirmed === false);
  check('北屿第 3 测次已定版且成活率 99%', c3?.confirmed === true && c3.survivalRate === 99);

  console.log('\n[2] 班组补植相符：只回写班组侧，不动任何测次');
  const beforeB1Rate = b1?.survivalRate;
  const beforeB1Alive = b1?.aliveCount;
  const res = await recordCrewCompletion('replant-a1', { actualCount: 1092, completedDate: '2025-04-12' });
  check('对账相符', res?.reconcile === 'matched' && res.actual === 1092);
  const plotArow = await db.plots.get(plotA);
  check('地块缺株数扣为 0', plotArow?.missingCount === 0);
  check('写入最近补植日期', plotArow?.lastReplantDate === '2025-04-12');
  check('班组实株数留底', plotArow?.crewReplantCount === 1092);
  check('班组测得成活率 = (4108+1092)/5200 = 100%', plotArow?.crewSurvivalRate === 100);
  const surveysA = await db.surveys.where('plotId').equals(plotA).toArray();
  check('验收测次数量不变（3 个）', surveysA.length === 3);
  const afterB1 = await db.surveys.get('survey-b1');
  check('已定级的西湾第 1 测次成活率未动', afterB1?.survivalRate === beforeB1Rate);
  check('已定级的西湾第 1 测次成活株数未动', afterB1?.aliveCount === beforeB1Alive);
  const a3 = await db.surveys.get('survey-a3');
  check('东港第 3 测次（未定级）成活率原样保留 79%', a3?.survivalRate === 79 && a3.aliveCount === 4108);
  const replantA = await db.replants.get('replant-a1');
  check('补植状态进入「已补植」等待重新验收', replantA?.state === '已补植' && replantA.reconcileStatus === 'matched');

  console.log('\n[3] 班组补植对不上 → 挂起待人定，不能复核');
  const replantNew = (
    await db.replants.put({
      id: 'replant-test-hold',
      plotId: plotA,
      missingCount: 100,
      planDate: '2025-05-01',
      species: '秋茄',
      state: '待补植',
      crewActualCount: null,
      completedDate: '',
      reconcileStatus: 'pending',
      reconcileNote: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 3,
    } as never),
    db.replants.get('replant-test-hold')
  );
  const heldRes = await recordCrewCompletion('replant-test-hold', { actualCount: 80, completedDate: '2025-05-03' });
  check('对账结论为 held', heldRes?.reconcile === 'held' && heldRes.expected === 100 && heldRes.actual === 80);
  const heldRow = await db.replants.get('replant-test-hold');
  check('挂起停在「待补植」', heldRow?.state === '待补植' && heldRow.reconcileStatus === 'held');
  let reviewError = '';
  try {
    await projectReviewReplant('replant-test-hold', { date: '2025-05-10', aliveCount: 5000, avgHeightCm: 100 });
  } catch (e) {
    reviewError = (e as Error).message;
  }
  check('挂起状态不允许项目部重新验收', reviewError.includes('对账相符'));

  console.log('\n[4a] 挂起裁决：认可班组数 → 平账');
  await resolveReplantHold('replant-test-hold', 'accept', '认可班组口径');
  const accepted = await db.replants.get('replant-test-hold');
  check('认可后平账进入已补植', accepted?.state === '已补植' && accepted.reconcileStatus === 'matched' && accepted.missingCount === 80);

  console.log('\n[5] 项目部重新验收：新测次定版，旧测次原样保留');
  const oldCount = (await db.surveys.where('plotId').equals(plotA).toArray()).length;
  const review = await projectReviewReplant('replant-a1', { date: '2025-05-20', aliveCount: 5150, avgHeightCm: 110 });
  check('新测次号 = 4', review.round === 4);
  check('新测次成活率 99% 且当场定级', review.survivalRate === 99 && review.confirmed === true && review.grade === 'excellent');
  const newCount = (await db.surveys.where('plotId').equals(plotA).toArray()).length;
  check('验收表新增 1 条（旧测次保留）', newCount === oldCount + 1);
  const a3Still = await db.surveys.get('survey-a3');
  check('原第 3 测次仍为 79% 未被改写', a3Still?.survivalRate === 79 && a3Still.confirmed === false);
  const replantADone = await db.replants.get('replant-a1');
  check('补植计划进入「已复核」', replantADone?.state === '已复核');
  const plotAdone = await db.plots.get(plotA);
  check('复核后缺株数以项目部最新验收为准 = 50', plotAdone?.missingCount === 50);

  console.log('\n[5b] 挂起退回：精确恢复项目部验收缺株数');
  await db.replants.put({
    id: 'replant-test-hold2',
    plotId: plotA,
    missingCount: 50,
    planDate: '2025-05-01',
    species: '秋茄',
    state: '待补植',
    crewActualCount: null,
    completedDate: '',
    reconcileStatus: 'pending',
    reconcileNote: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 3,
  } as never);
  const plotABefore = await db.plots.get(plotA);
  await recordCrewCompletion('replant-test-hold2', { actualCount: 30, completedDate: '2025-05-03' });
  const plotAAfterHeld = await db.plots.get(plotA);
  check('挂起时按实补 30 扣减缺株（50 → 20）', plotAAfterHeld?.missingCount === 20);
  await resolveReplantHold('replant-test-hold2', 'return', '');
  const returned = await db.replants.get('replant-test-hold2');
  check('退回后清空班组登记并回到 pending', returned?.crewActualCount === null && returned.reconcileStatus === 'pending');
  const plotAAfterReturn = await db.plots.get(plotA);
  check('退回后地块缺株数精确恢复为 50', plotAAfterReturn?.missingCount === plotABefore?.missingCount && plotAAfterReturn?.missingCount === 50);

  console.log('\n[6] 地块潮位带变更 → 引用结论全部失效重算');
  const plotBBeforeChange = (await db.surveys.where('plotId').equals(plotB).toArray()).map((s) => s.id);
  await patchPlot(plotB, { tideZone: '中' } as never);
  const afterChange = await db.surveys.where('plotId').equals(plotB).toArray();
  check('西湾全部测次结论失效', afterChange.every((s) => s.conditionsValid === false), JSON.stringify(afterChange.map((s) => s.conditionsValid)));
  check('失效原因已记录', afterChange.every((s) => s.invalidReason.includes('潮位带')));
  check('测次记录仍在（留痕）', afterChange.length === plotBBeforeChange.length);
  // 其他地块不受影响
  const c3StillValid = await db.surveys.get('survey-c3');
  check('北屿测次不受西湾变更影响', c3StillValid?.conditionsValid === true);

  console.log('\n[7] 定级锁定：confirmSurveys');
  const count = await confirmSurveys(['survey-a1']);
  const a1 = await db.surveys.get('survey-a1');
  check('确认数返回 1', count === 1);
  check('survey-a1 已锁定并写定级日期', a1?.confirmed === true && typeof a1.confirmedDate === 'string' && a1.confirmedDate !== '');

  console.log(`\n${failures === 0 ? '🎉 全部规则验证通过' : `⚠️ ${failures} 条断言失败`}`);
  void replantNew;
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
