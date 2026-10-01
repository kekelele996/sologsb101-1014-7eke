/**
 * /plots 修复地块台账
 * 新建地块、按潮位带与底质筛选、查看栽植总株数与最新成活率、级联删除。
 * 消费模型：Plot、Planting、Survey；复用组件：<RateTag>、<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  EnvironmentOutlined,
  ExperimentOutlined,
  PlusOutlined,
  RiseOutlined,
  FallOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import FilterBar from '../components/common/FilterBar';
import EmptyPanel from '../components/common/EmptyPanel';
import RateTag from '../components/common/RateTag';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import {
  PLOT_STATE_OPTIONS,
  RESTORE_MODE_OPTIONS,
  SUBSTRATE_OPTIONS,
  TIDE_ZONE_OPTIONS,
  type Plot,
  type PlotDraft,
} from '../types/plot';
import { ROUTES } from '../router';
import { percentText } from '../utils/rate';

const DEFAULT_DRAFT: PlotDraft = {
  name: '',
  areaMu: 30,
  tideZone: '中',
  substrate: '淤泥质',
  restoreMode: '造林',
  state: '跟踪中',
};

export default function PlotList() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plots = usePlotStore((state) => state.plots);
  const filters = usePlotStore((state) => state.filters);
  const setFilters = usePlotStore((state) => state.setFilters);
  const resetFilters = usePlotStore((state) => state.resetFilters);
  const visiblePlots = usePlotStore((state) => state.visiblePlots);
  const statOf = usePlotStore((state) => state.statOf);
  const createPlot = usePlotStore((state) => state.createPlot);
  const updatePlot = usePlotStore((state) => state.updatePlot);
  const deletePlot = usePlotStore((state) => state.deletePlot);
  const selectPlot = usePlotStore((state) => state.selectPlot);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Plot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<PlotDraft>();

  const rows = useMemo(() => visiblePlots(), [visiblePlots, plots, filters]);

  const totals = useMemo(() => {
    const plantTotal = plots.reduce((acc, plot) => acc + statOf(plot.id).plantTotal, 0);
    const rated = plots.filter((plot) => statOf(plot.id).surveyCount > 0);
    const avgRate =
      rated.length === 0
        ? 0
        : Math.round((rated.reduce((acc, plot) => acc + statOf(plot.id).latestRate, 0) / rated.length) * 10) / 10;
    const warnCount = plots.filter((plot) => statOf(plot.id).surveyCount > 0 && statOf(plot.id).latestRate < 70).length;
    return { plantTotal, avgRate, warnCount };
  }, [plots, statOf]);

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue(DEFAULT_DRAFT);
    setOpen(true);
  };

  const openEdit = (plot: Plot): void => {
    setEditing(plot);
    form.setFieldsValue({
      name: plot.name,
      areaMu: plot.areaMu,
      tideZone: plot.tideZone,
      substrate: plot.substrate,
      restoreMode: plot.restoreMode,
      state: plot.state,
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (editing === null) {
        const row = await createPlot(values);
        message.success(`已新建地块「${row.name}」，可继续登记苗木批次`);
      } else {
        await updatePlot(editing.id, values);
        message.success('地块信息已更新');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (plot: Plot): Promise<void> => {
    try {
      await deletePlot(plot.id);
      message.success(`已删除地块「${plot.name}」及其全部子记录`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const columns: ColumnsType<Plot> = [
    {
      title: '地块名',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Link
            onClick={() => {
              selectPlot(record.id);
              navigate(ROUTES.seedlings(record.id));
            }}
          >
            {record.name}
          </Typography.Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.restoreMode} · {record.substrate}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '面积（亩）',
      dataIndex: 'areaMu',
      key: 'areaMu',
      width: 96,
      align: 'right',
      sorter: (a, b) => a.areaMu - b.areaMu,
    },
    {
      title: '潮位带',
      dataIndex: 'tideZone',
      key: 'tideZone',
      width: 90,
      render: (value: string) => <Tag color="cyan">{value}</Tag>,
    },
    {
      title: '底质',
      dataIndex: 'substrate',
      key: 'substrate',
      width: 96,
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 92,
      render: (value: string) => <Tag color={value === '已验收' ? 'green' : 'blue'}>{value}</Tag>,
    },
    {
      title: '苗木批次',
      key: 'seedlingCount',
      width: 96,
      align: 'right',
      render: (_value, record) => `${statOf(record.id).seedlingCount} 批`,
    },
    {
      title: '栽植总株数',
      key: 'plantTotal',
      width: 112,
      align: 'right',
      sorter: (a, b) => statOf(a.id).plantTotal - statOf(b.id).plantTotal,
      render: (_value, record) => `${statOf(record.id).plantTotal.toLocaleString('zh-CN')} 株`,
    },
    {
      title: '验收测次',
      key: 'surveyCount',
      width: 96,
      align: 'right',
      render: (_value, record) => `${statOf(record.id).surveyCount} 次`,
    },
    {
      title: '最新成活率',
      key: 'latestRate',
      width: 190,
      render: (_value, record) => {
        const stat = statOf(record.id);
        return (
          <Space size={6} wrap>
            <RateTag rate={stat.surveyCount > 0 ? stat.latestRate : null} level={stat.level} />
            {stat.surveyCount > 0 && stat.trend !== 0 ? (
              <Typography.Text type={stat.trend > 0 ? 'success' : 'danger'} style={{ fontSize: 12 }}>
                {stat.trend > 0 ? <RiseOutlined /> : <FallOutlined />} {Math.abs(stat.trend)}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '缺株数',
      dataIndex: 'missingCount',
      key: 'missingCount',
      width: 96,
      align: 'right',
      render: (value: number) => (
        <Typography.Text type={value > 0 ? 'warning' : 'secondary'}>{value} 株</Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            onClick={() => {
              selectPlot(record.id);
              navigate(ROUTES.seedlings(record.id));
            }}
          >
            苗木批次
          </Button>
          <Button
            size="small"
            type="link"
            onClick={() => {
              selectPlot(record.id);
              navigate(ROUTES.plantings(record.id));
            }}
          >
            栽植记录
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该地块？"
            description="该地块下的苗木批次、栽植记录、验收记录与补植计划会一并删除，且不可恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleDelete(record)}
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
        <StatBadge label="地块总数" value={plots.length} suffix="块" tone="primary" icon={<EnvironmentOutlined />} />
        <StatBadge
          label="栽植总株数"
          value={totals.plantTotal.toLocaleString('zh-CN')}
          suffix="株"
          tone="info"
          icon={<ExperimentOutlined />}
        />
        <StatBadge
          label="平均成活率"
          value={percentText(totals.avgRate)}
          percent={totals.avgRate}
          tone="success"
        />
        <StatBadge
          label="成活率告警地块"
          value={totals.warnCount}
          suffix="块"
          tone={totals.warnCount > 0 ? 'danger' : 'default'}
          hint="成活率低于 70% 的地块数量"
        />
        <StatBadge label="筛选结果" value={rows.length} suffix="块" tone="default" size="small" />
      </div>

      <Card
        title="修复地块台账"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建地块
          </Button>
        }
        styles={{ body: { paddingTop: 12 } }}
      >
        <FilterBar
          keyword={filters.keyword}
          onKeywordChange={(value: string) => setFilters({ keyword: value })}
          fields={[
            { key: 'tideZone', label: '潮位带', options: [...TIDE_ZONE_OPTIONS] },
            { key: 'substrate', label: '底质', options: [...SUBSTRATE_OPTIONS] },
          ]}
          values={{ tideZone: filters.tideZone, substrate: filters.substrate }}
          onChange={(key: string, value: string) => {
            if (key === 'tideZone') setFilters({ tideZone: value as PlotDraft['tideZone'] | 'all' });
            if (key === 'substrate') setFilters({ substrate: value as PlotDraft['substrate'] | 'all' });
          }}
          onReset={resetFilters}
          resultText={`命中 ${rows.length} / ${plots.length} 块`}
        />

        {ready && plots.length === 0 ? (
          <EmptyPanel
            title="还没有修复地块"
            description="先建立修复地块，再登记苗木批次与栽植记录，才能开始按测次验收成活率。"
            actionText="新建第一个地块"
            onAction={openCreate}
          />
        ) : (
          <Table<Plot>
            rowKey="id"
            size="middle"
            loading={!ready}
            columns={columns}
            dataSource={rows}
            scroll={{ x: 1480 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel
                  title="没有符合筛选条件的地块"
                  description="可以调整潮位带 / 底质筛选条件，或直接重置筛选。"
                  actionText="重置筛选"
                  onAction={resetFilters}
                />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '新建修复地块' : `编辑地块 · ${editing.name}`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={DEFAULT_DRAFT}>
          <Form.Item
            name="name"
            label="地块名"
            rules={[{ required: true, message: '请填写地块名' }, { max: 40, message: '地块名不超过 40 字' }]}
          >
            <Input placeholder="如：东港南堤 3 号地块" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="areaMu"
              label="面积（亩）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写面积' }]}
            >
              <InputNumber min={0.1} max={5000} step={0.5} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="tideZone" label="潮位带" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={TIDE_ZONE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="substrate" label="底质" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SUBSTRATE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="restoreMode" label="修复方式" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={RESTORE_MODE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="state" label="跟踪状态" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={PLOT_STATE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            保存后会自动成为「当前地块」，可直接进入苗木批次与栽植记录登记。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
