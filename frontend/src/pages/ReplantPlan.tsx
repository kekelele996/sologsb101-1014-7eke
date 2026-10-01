/**
 * /replants 补植计划与结构版本
 * 两侧分离：
 * - 班组侧：现场登记补植完成（只更新地块缺株数 / 最近补植日期 / 班组实测成活率，不动已定级测次）；
 * - 项目部侧：对账相符后重新验收，以新测次定级定版；
 * - 班组实植株数与项目部验收口径对不上时挂起，由人裁决（认可平账 / 退回重报）。
 * 消费模型：Replant、Survey、全部模型；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ClearOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useReplantStore } from '../stores/replantStore';
import { DB_NAME, DB_SCHEMA_VERSION, db } from '../utils/db';
import {
  REPLANT_STATE_OPTIONS,
  RECONCILE_STATUS_LABEL,
  type Replant,
  type ReplantDraft,
  type ReplantState,
  type ReconcileStatus,
} from '../types/replant';
import { SEEDLING_SPECIES_OPTIONS, type SeedlingSpecies } from '../types/seedling';
import { exportSnapshotJson, exportSummaryCsvFile, parseSnapshot } from '../utils/export';
import { percentText } from '../utils/rate';

interface ReplantFormValues {
  plotId: string;
  missingCount: number;
  planDate: Dayjs;
  species: SeedlingSpecies;
  state: ReplantState;
}

interface CrewFormValues {
  actualCount: number;
  completedDate: Dayjs;
}

interface ReviewFormValues {
  date: Dayjs;
  aliveCount: number;
  avgHeightCm: number;
}

const RECONCILE_COLOR: Record<ReconcileStatus, string> = {
  pending: 'default',
  matched: 'green',
  held: 'red',
};

export default function ReplantPlan() {
  const { message, modal } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const seedlings = usePlotStore((state) => state.seedlings);
  const plantings = usePlotStore((state) => state.plantings);
  const surveys = usePlotStore((state) => state.surveys);
  const statOf = usePlotStore((state) => state.statOf);
  const ready = usePlotStore((state) => state.ready);

  const filters = useReplantStore((state) => state.filters);
  const setFilters = useReplantStore((state) => state.setFilters);
  const resetFilters = useReplantStore((state) => state.resetFilters);
  const createReplant = useReplantStore((state) => state.createReplant);
  const deleteReplant = useReplantStore((state) => state.deleteReplant);
  const recordCrewCompletion = useReplantStore((state) => state.recordCrewCompletion);
  const resolveHold = useReplantStore((state) => state.resolveHold);
  const projectReview = useReplantStore((state) => state.projectReview);
  const exportAll = useReplantStore((state) => state.exportAll);
  const importAll = useReplantStore((state) => state.importAll);
  const resetAll = useReplantStore((state) => state.resetAll);
  const lastMessage = useReplantStore((state) => state.lastMessage);

  const { rows, loading, update } = useIdbTable<Replant>(db.replants, { sortByUpdatedAt: false });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Replant | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [crewTarget, setCrewTarget] = useState<Replant | null>(null);
  const [reviewTarget, setReviewTarget] = useState<Replant | null>(null);
  const [crewSubmitting, setCrewSubmitting] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [form] = Form.useForm<ReplantFormValues>();
  const [crewForm] = Form.useForm<CrewFormValues>();
  const [reviewForm] = Form.useForm<ReviewFormValues>();

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const filtered = useMemo(() => {
    const key = filters.keyword.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.state !== 'all' && row.state !== filters.state) return false;
        if (filters.reconcile !== 'all' && row.reconcileStatus !== filters.reconcile) return false;
        if (key === '') return true;
        return plotName(row.plotId).toLowerCase().includes(key) || row.species.toLowerCase().includes(key);
      })
      .sort((a, b) => a.planDate.localeCompare(b.planDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, plots]);

  const stats = useMemo(() => {
    const held = rows.filter((row) => row.reconcileStatus === 'held');
    const reviewed = rows.filter((row) => row.state === '已复核').length;
    const pending = rows.filter((row) => row.state === '待补植').length;
    return {
      heldCount: held.length,
      pending,
      reviewed,
      reviewPct: rows.length === 0 ? 0 : Math.round((reviewed / rows.length) * 1000) / 10,
    };
  }, [rows]);

  const openCreate = (): void => {
    setEditing(null);
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    const stat = statOf(plotId);
    form.setFieldsValue({
      plotId,
      missingCount: stat.suggestReplant > 0 ? stat.suggestReplant : 100,
      planDate: dayjs().add(15, 'day'),
      species: seedlings.find((row) => row.plotId === plotId)?.species ?? '秋茄',
      state: '待补植',
    });
    setOpen(true);
  };

  const openEdit = (row: Replant): void => {
    setEditing(row);
    form.setFieldsValue({
      plotId: row.plotId,
      missingCount: row.missingCount,
      planDate: dayjs(row.planDate),
      species: row.species,
      state: row.state,
    });
    setOpen(true);
  };

  const openCrew = (row: Replant): void => {
    setCrewTarget(row);
    crewForm.setFieldsValue({ actualCount: row.missingCount, completedDate: dayjs() });
  };

  const openReview = (row: Replant): void => {
    setReviewTarget(row);
    const stat = statOf(row.plotId);
    // 默认按「最新成活 + 班组实补」给出建议值，项目部可按现场实测修改
    reviewForm.setFieldsValue({
      date: dayjs(),
      aliveCount: stat.plantTotal,
      avgHeightCm: 0,
    });
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload: ReplantDraft = {
        plotId: values.plotId,
        missingCount: values.missingCount,
        planDate: values.planDate.format('YYYY-MM-DD'),
        species: values.species,
        state: values.state,
      };
      if (editing === null) {
        await createReplant(payload);
        message.success(`已创建补植计划：缺株 ${payload.missingCount} 株`);
      } else {
        await update(editing.id, payload);
        message.success('补植计划已更新');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCrewSubmit = async (): Promise<void> => {
    if (crewTarget === null) return;
    try {
      const values = await crewForm.validateFields();
      setCrewSubmitting(true);
      const result = await recordCrewCompletion(crewTarget.id, {
        actualCount: values.actualCount,
        completedDate: values.completedDate.format('YYYY-MM-DD'),
      });
      if (result === null) return;
      if (result.reconcile === 'held') {
        message.warning(
          `班组实补 ${result.actual} 株，与项目部验收缺株 ${result.expected} 株不符，已挂起待人定`,
          6,
        );
      } else {
        message.success(
          `班组补植 ${result.actual} 株已登记，班组测得最新成活率 ${result.crewRate}%；项目部已定级测次未改动`,
          6,
        );
      }
      setCrewTarget(null);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setCrewSubmitting(false);
    }
  };

  const handleResolve = (row: Replant, action: 'accept' | 'return'): void => {
    modal.confirm({
      title: action === 'accept' ? '认可班组实补株数并平账？' : '退回班组重新清点补报？',
      content:
        action === 'accept'
          ? `将以班组实补 ${row.crewActualCount ?? 0} 株作为双方认可口径平账，随后可由项目部重新验收。`
          : '将清空本次班组实补登记并恢复地块缺株数，班组需重新清点补报。',
      okText: action === 'accept' ? '认可平账' : '退回重报',
      cancelText: '取消',
      onOk: async () => {
        await resolveHold(row.id, action, '');
        message.success(action === 'accept' ? '已按班组实补株数平账' : '已退回班组重报');
      },
    });
  };

  const handleReviewSubmit = async (): Promise<void> => {
    if (reviewTarget === null) return;
    try {
      const values = await reviewForm.validateFields();
      setReviewSubmitting(true);
      const survey = await projectReview(reviewTarget.id, {
        date: values.date.format('YYYY-MM-DD'),
        aliveCount: values.aliveCount,
        avgHeightCm: values.avgHeightCm,
      });
      message.success(`项目部已按第 ${survey.round} 测次重新验收，成活率 ${survey.survivalRate}%，等级已定版`);
      setReviewTarget(null);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setReviewSubmitting(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    const snapshot = await exportAll();
    const filename = exportSnapshotJson(snapshot);
    message.success(`已导出整库存档 ${filename}`);
  };

  const handleExportCsv = (): void => {
    const filename = exportSummaryCsvFile(plots, seedlings, plantings, surveys, rows);
    message.success(`已导出成活率汇总 ${filename}`);
  };

  const handleImportFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const result = parseSnapshot(text);
    if (!result.ok || result.snapshot === null) {
      message.error(result.message);
      return;
    }
    await importAll(result.snapshot);
    await usePlotStore.getState().refreshCounts();
    message.success(`导入成功：${result.message}`);
  };

  const handleReset = (): void => {
    modal.confirm({
      title: '确认重置本地数据？',
      content: '全部地块、苗木批次、栽植记录、验收记录与补植计划都会被清空，并重新灌入演示数据。',
      okText: '确认重置',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await resetAll();
        await usePlotStore.getState().refreshCounts();
        message.success('已重置为演示数据');
      },
    });
  };

  const columns: ColumnsType<Replant> = [
    {
      title: '地块',
      key: 'plot',
      width: 220,
      render: (_value, record) => {
        const stat = statOf(record.plotId);
        const plot = plots.find((item) => item.id === record.plotId);
        return (
          <Space direction="vertical" size={0}>
            <span>{plotName(record.plotId)}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              项目部最新{' '}
              {stat.surveyCount > 0 ? percentText(stat.latestRate) : '未验收'}
              {plot && plot.crewRateDate ? ` · 班组测得 ${percentText(plot.crewSurvivalRate)}` : ''} · 栽植{' '}
              {stat.plantTotal.toLocaleString('zh-CN')} 株
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '验收缺株（对账基准）',
      dataIndex: 'missingCount',
      key: 'missingCount',
      width: 150,
      align: 'right',
      render: (value: number) => `${value.toLocaleString('zh-CN')} 株`,
    },
    {
      title: '班组实补',
      key: 'crewActualCount',
      width: 130,
      align: 'right',
      render: (_value, record) =>
        record.crewActualCount === null ? (
          <Typography.Text type="secondary">未登记</Typography.Text>
        ) : (
          `${record.crewActualCount.toLocaleString('zh-CN')} 株`
        ),
    },
    {
      title: '完成日期',
      key: 'completedDate',
      width: 120,
      render: (_value, record) => record.completedDate || '—',
    },
    {
      title: '计划日期',
      dataIndex: 'planDate',
      key: 'planDate',
      width: 120,
    },
    {
      title: '补植树种',
      key: 'species',
      width: 120,
      render: (_value, record) => <Tag color="green">{record.species}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 100,
      render: (value: ReplantState) => (
        <Tag color={value === '待补植' ? 'orange' : value === '已补植' ? 'blue' : 'green'}>{value}</Tag>
      ),
    },
    {
      title: '对账',
      key: 'reconcileStatus',
      width: 150,
      render: (_value, record) => (
        <Tooltip title={record.reconcileNote}>
          <Tag
            color={RECONCILE_COLOR[record.reconcileStatus]}
            icon={record.reconcileStatus === 'held' ? <StopOutlined /> : undefined}
          >
            {RECONCILE_STATUS_LABEL[record.reconcileStatus]}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 320,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.state === '待补植' && record.reconcileStatus !== 'held' ? (
            <Button size="small" type="primary" ghost onClick={() => openCrew(record)}>
              班组登记完成
            </Button>
          ) : null}
          {record.reconcileStatus === 'held' ? (
            <>
              <Button size="small" type="link" icon={<SafetyCertificateOutlined />} onClick={() => handleResolve(record, 'accept')}>
                认可平账
              </Button>
              <Button size="small" type="link" danger icon={<RollbackOutlined />} onClick={() => handleResolve(record, 'return')}>
                退回重报
              </Button>
            </>
          ) : null}
          {record.state === '已补植' && record.reconcileStatus === 'matched' ? (
            <Button size="small" type="primary" icon={<SafetyCertificateOutlined />} onClick={() => openReview(record)}>
              项目部重新验收
            </Button>
          ) : null}
          {record.state === '已复核' ? <Tag color="green">已重新验收定级</Tag> : null}
          <Button
            size="small"
            type="link"
            icon={<EditOutlined />}
            disabled={record.state === '已复核'}
            onClick={() => openEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除该补植计划？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteReplant(record.id);
              message.success('补植计划已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="补植计划" value={rows.length} suffix="条" tone="primary" />
        <StatBadge label="待补植" value={stats.pending} suffix="条" tone={stats.pending > 0 ? 'warning' : 'default'} />
        <StatBadge
          label="对账挂起"
          value={stats.heldCount}
          suffix="条"
          tone={stats.heldCount > 0 ? 'danger' : 'default'}
          hint="班组实植株数与项目部验收缺株对不上，待人裁决"
        />
        <StatBadge
          label="复核完成率"
          value={percentText(stats.reviewPct)}
          percent={stats.reviewPct}
          tone="success"
          hint="状态为「已复核」（项目部重新验收）的计划占比"
        />
        <StatBadge
          label="数据结构版本"
          value={`v${DB_SCHEMA_VERSION}`}
          suffix={`· ${DB_NAME}`}
          tone="info"
          hint="IndexedDB 库名与结构版本号；升级时会按 version().stores() 自动迁移"
        />
      </div>

      {lastMessage !== '' ? (
        <Alert type="info" showIcon style={{ marginBottom: 14 }} message={lastMessage} />
      ) : null}

      {stats.heldCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${stats.heldCount} 条补植计划班组实株数与项目部验收对不上，已挂起待人定`}
          description="挂起期间不得推进复核；可「认可班组实补株数平账」后交项目部重新验收，或「退回班组重新清点补报」。"
        />
      ) : null}

      <Card
        title="补植计划与结构版本"
        extra={
          <Space wrap>
            <Button icon={<DownloadOutlined />} onClick={() => void handleExport()}>
              导出 JSON 存档
            </Button>
            <Button icon={<DownloadOutlined />} onClick={handleExportCsv}>
              导出 CSV 汇总
            </Button>
            <Upload
              accept=".json"
              showUploadList={false}
              beforeUpload={(file) => {
                void handleImportFile(file as unknown as File);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>导入 JSON 存档</Button>
            </Upload>
            <Button danger icon={<ClearOutlined />} onClick={handleReset}>
              重置演示数据
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plots.length === 0}>
              新建补植计划
            </Button>
          </Space>
        }
      >
        <FilterBar
          keyword={filters.keyword}
          onKeywordChange={(value: string) => setFilters({ keyword: value })}
          fields={[
            { key: 'plotId', label: '地块', options: plots.map((plot) => plot.id), optionLabels: Object.fromEntries(plots.map((plot) => [plot.id, plot.name])) },
            { key: 'state', label: '状态', options: [...REPLANT_STATE_OPTIONS] },
            {
              key: 'reconcile',
              label: '对账',
              options: ['pending', 'matched', 'held'],
              optionLabels: { pending: '未对账', matched: '账实相符', held: '挂起待人定' },
            },
          ]}
          values={{ plotId: filters.plotId, state: filters.state, reconcile: filters.reconcile }}
          onChange={(key: string, value: string) => {
            if (key === 'plotId') setFilters({ plotId: value });
            if (key === 'state') setFilters({ state: value as ReplantState | 'all' });
            if (key === 'reconcile') setFilters({ reconcile: value as ReconcileStatus | 'all' });
          }}
          onReset={resetFilters}
          resultText={`命中 ${filtered.length} / ${rows.length} 条`}
        />

        {rows.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有补植计划"
            description="验收成活率偏低时可一键生成补植计划；班组现场登记补植完成后，与项目部验收对账相符方可重新验收，对不上先挂起待人定。"
            actionText="新建补植计划"
            onAction={openCreate}
          />
        ) : (
          <Table<Replant>
            rowKey="id"
            size="middle"
            loading={loading || !ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1500 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            rowClassName={(record) => (record.reconcileStatus === 'held' ? 'replant-row-held' : '')}
            locale={{
              emptyText: <EmptyPanel title="没有符合筛选条件的补植计划" actionText="重置筛选" onAction={resetFilters} />,
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '新建补植计划' : '编辑补植计划'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="plotId" label="地块" rules={[{ required: true, message: '请选择地块' }]}>
            <Select options={plots.map((plot) => ({ value: plot.id, label: plot.name }))} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="missingCount"
              label="缺株数（株，项目部验收口径）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写缺株数' }]}
            >
              <InputNumber min={1} max={200000} step={10} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="planDate" label="计划日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="species" label="补植树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="state" label="状态" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={REPLANT_STATE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            班组补植完成只更新地块缺株数与班组实测成活率；项目部已定级的测次与等级不会被带着改，对账相符后由项目部重新验收才算数。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title="班组现场登记补植完成"
        open={crewTarget !== null}
        onCancel={() => setCrewTarget(null)}
        onOk={() => void handleCrewSubmit()}
        confirmLoading={crewSubmitting}
        okText="提交登记"
        cancelText="取消"
      >
        {crewTarget ? (
          <Form form={crewForm} layout="vertical">
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={`${plotName(crewTarget.plotId)} · 项目部验收缺株 ${crewTarget.missingCount} 株（对账基准）`}
              description="仅回写地块缺株数、最近补植日期与班组实测成活率；项目部已定级的测次与等级不会改动。"
            />
            <Space size={12} style={{ display: 'flex' }}>
              <Form.Item
                name="actualCount"
                label="班组现场实补株数"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写现场实补株数' }]}
              >
                <InputNumber min={1} max={200000} step={10} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="completedDate" label="补植完成日期" style={{ flex: 1 }} rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              实植株数与项目部验收缺株对不上时，本计划会自动挂起，暂停推进并通知负责人裁决。
            </Typography.Text>
          </Form>
        ) : null}
      </Modal>

      <Modal
        title="项目部重新验收"
        open={reviewTarget !== null}
        onCancel={() => setReviewTarget(null)}
        onOk={() => void handleReviewSubmit()}
        confirmLoading={reviewSubmitting}
        okText="提交并定级定版"
        cancelText="取消"
      >
        {reviewTarget ? (
          <Form form={reviewForm} layout="vertical">
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={`${plotName(reviewTarget.plotId)} · 班组实补 ${reviewTarget.crewActualCount ?? 0} 株，账实相符`}
              description="作为新测次登记成活株数并当场定级，原各测次原样保留、不受影响。"
            />
            <Space size={12} style={{ display: 'flex' }}>
              <Form.Item name="date" label="验收日期" style={{ flex: 1 }} rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="avgHeightCm"
                label="平均株高（cm）"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写平均株高' }]}
              >
                <InputNumber min={0} max={2000} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Space>
            <Form.Item
              name="aliveCount"
              label="重新验收成活株数"
              rules={[{ required: true, message: '请填写成活株数' }]}
            >
              <InputNumber min={0} max={500000} step={10} style={{ width: '100%' }} />
            </Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              成活率 = 成活株数 / 栽植总株数，保存时自动计算并定级定版；此后班组补植不得再改写本测次。
            </Typography.Text>
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
