/**
 * /plots/:id/plantings 栽植记录
 * 录入株距与株数并即时提示栽植密度是否异常。
 * 消费模型：Planting、Seedling；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
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
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { db } from '../utils/db';
import type { Planting } from '../types/planting';
import type { Seedling } from '../types/seedling';
import { ROUTES } from '../router';
import {
  DENSITY_MAX_M2_PER_PLANT,
  DENSITY_MIN_M2_PER_PLANT,
  checkDensity,
  muToM2,
  type DensityCheck,
} from '../utils/rate';

interface PlantingFormValues {
  seedlingId: string;
  plantDate: Dayjs;
  spacingM: number;
  count: number;
  operator: string;
}

const DEFAULT_VALUES: PlantingFormValues = {
  seedlingId: '',
  plantDate: dayjs(),
  spacingM: 1,
  count: 1000,
  operator: '',
};

export default function PlantingEntry() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));

  const seedlingTable = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const { rows, loading, create, update, remove } = useIdbTable<Planting>(db.plantings, { sortByUpdatedAt: false });

  const [keyword, setKeyword] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Planting | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [density, setDensity] = useState<DensityCheck | null>(null);
  const [form] = Form.useForm<PlantingFormValues>();

  const plotSeedlings = useMemo(
    () => seedlingTable.rows.filter((row) => row.plotId === id),
    [seedlingTable.rows, id],
  );

  const plotPlantings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.plantDate.localeCompare(a.plantDate)),
    [rows, id],
  );

  const operatorOptions = useMemo(
    () => Array.from(new Set(plotPlantings.map((row) => row.operator).filter((item) => item !== ''))),
    [plotPlantings],
  );

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return plotPlantings.filter((row) => {
      if (operatorFilter !== 'all' && row.operator !== operatorFilter) return false;
      if (key === '') return true;
      const species = plotSeedlings.find((item) => item.id === row.seedlingId)?.species ?? '';
      return (
        row.operator.toLowerCase().includes(key) ||
        species.toLowerCase().includes(key) ||
        row.plantDate.includes(key)
      );
    });
  }, [plotPlantings, plotSeedlings, keyword, operatorFilter]);

  const totalCount = plotPlantings.reduce((acc, row) => acc + row.count, 0);
  const avgSpacing =
    plotPlantings.length === 0
      ? 0
      : Math.round((plotPlantings.reduce((acc, row) => acc + row.spacingM, 0) / plotPlantings.length) * 100) / 100;
  const usedSeedlingIds = new Set(plotPlantings.map((row) => row.seedlingId));

  const seedlingLabel = (seedlingId: string): string => {
    const seedling = seedlingTable.rows.find((row) => row.id === seedlingId);
    return seedling === undefined ? '（批次已删除）' : `${seedling.species} · ${seedling.spec}`;
  };

  const openCreate = (): void => {
    setEditing(null);
    setDensity(null);
    form.setFieldsValue({
      ...DEFAULT_VALUES,
      seedlingId: plotSeedlings.length > 0 ? plotSeedlings[0].id : '',
      plantDate: dayjs(),
    });
    setOpen(true);
  };

  const openEdit = (row: Planting): void => {
    setEditing(row);
    form.setFieldsValue({
      seedlingId: row.seedlingId,
      plantDate: dayjs(row.plantDate),
      spacingM: row.spacingM,
      count: row.count,
      operator: row.operator,
    });
    setDensity(plot === undefined ? null : checkDensity(plot.areaMu, row.spacingM, row.count));
    setOpen(true);
  };

  const handleValuesChange = (): void => {
    if (plot === undefined) return;
    const values = form.getFieldsValue();
    setDensity(checkDensity(plot.areaMu, values.spacingM, values.count));
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        plotId: id,
        seedlingId: values.seedlingId,
        plantDate: values.plantDate.format('YYYY-MM-DD'),
        spacingM: values.spacingM,
        count: values.count,
        operator: values.operator.trim(),
      };
      if (editing === null) {
        await create(payload, 'planting');
        message.success(`已登记栽植 ${payload.count} 株`);
      } else {
        await update(editing.id, payload);
        message.success('栽植记录已更新');
      }
      const check = plot === undefined ? null : checkDensity(plot.areaMu, payload.spacingM, payload.count);
      if (check !== null && !check.ok) {
        message.warning(check.message, 6);
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!ready) {
    return <Card loading title="栽植记录" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块，无法登记栽植记录。`}
        actionText="返回地块台账"
        onAction={() => navigate(ROUTES.plots)}
        extra={
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
            返回
          </Button>
        }
      />
    );
  }

  const columns: ColumnsType<Planting> = [
    {
      title: '栽植日期',
      dataIndex: 'plantDate',
      key: 'plantDate',
      width: 130,
      sorter: (a, b) => a.plantDate.localeCompare(b.plantDate),
    },
    {
      title: '苗木批次',
      key: 'seedling',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{seedlingLabel(record.seedlingId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {plotSeedlings.find((item) => item.id === record.seedlingId)?.source ?? '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '株距（米）',
      dataIndex: 'spacingM',
      key: 'spacingM',
      width: 110,
      align: 'right',
      render: (value: number) => value.toFixed(2),
    },
    {
      title: '株数',
      dataIndex: 'count',
      key: 'count',
      width: 110,
      align: 'right',
      sorter: (a, b) => a.count - b.count,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '平均单株占地',
      key: 'perPlant',
      width: 140,
      align: 'right',
      render: (_value, record) => `${checkDensity(plot.areaMu, record.spacingM, record.count).areaPerPlant} ㎡/株`,
    },
    {
      title: '密度校验',
      key: 'densityCheck',
      width: 130,
      render: (_value, record) => {
        const check = checkDensity(plot.areaMu, record.spacingM, record.count);
        return (
          <Tag color={check.level === 'success' ? 'green' : check.level === 'warning' ? 'orange' : 'red'}>
            {check.ok ? '合理' : check.level === 'warning' ? '偏疏' : '异常'}
          </Tag>
        );
      },
    },
    { title: '班组', dataIndex: 'operator', key: 'operator', width: 120 },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该栽植记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await remove(record.id);
              message.success('栽植记录已删除');
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
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
          返回地块台账
        </Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {plot.name} · 栽植记录
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>
          {plot.areaMu} 亩 / {Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡
        </Tag>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="栽植记录" value={plotPlantings.length} suffix="条" tone="primary" />
        <StatBadge label="栽植总株数" value={totalCount.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge label="平均株距" value={avgSpacing.toFixed(2)} suffix="米" tone="default" />
        <StatBadge
          label="已引用批次"
          value={`${usedSeedlingIds.size} / ${plotSeedlings.length}`}
          percent={plotSeedlings.length > 0 ? (usedSeedlingIds.size / plotSeedlings.length) * 100 : 0}
          tone="success"
          hint="已被栽植记录引用的苗木批次占全部批次的比例"
        />
      </div>

      {plotSeedlings.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="该地块尚未登记苗木批次"
          description="栽植记录必须引用一个苗木批次，请先到苗木批次页登记进场苗木。"
          action={
            <Button size="small" onClick={() => navigate(ROUTES.seedlings(plot.id))}>
              去登记苗木批次
            </Button>
          }
        />
      ) : null}

      <Card
        title="栽植记录"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plotSeedlings.length === 0}>
            新增栽植记录
          </Button>
        }
      >
        <FilterBar
          keyword={keyword}
          onKeywordChange={setKeyword}
          fields={[{ key: 'operator', label: '班组', options: operatorOptions }]}
          values={{ operator: operatorFilter }}
          onChange={(key: string, value: string) => {
            if (key === 'operator') setOperatorFilter(value);
          }}
          onReset={() => {
            setKeyword('');
            setOperatorFilter('all');
          }}
          resultText={`命中 ${filtered.length} / ${plotPlantings.length} 条`}
        />

        {plotPlantings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有栽植记录"
            description="录入栽植日期、株距与株数，系统会按地块面积自动校验栽植密度是否合理。"
            actionText="新增栽植记录"
            onAction={openCreate}
          />
        ) : (
          <Table<Planting>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={filtered}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel
                  title="没有符合筛选条件的栽植记录"
                  actionText="重置筛选"
                  onAction={() => {
                    setKeyword('');
                    setOperatorFilter('all');
                  }}
                />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '新增栽植记录' : '编辑栽植记录'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={DEFAULT_VALUES} onValuesChange={handleValuesChange}>
          <Form.Item name="seedlingId" label="苗木批次" rules={[{ required: true, message: '请选择苗木批次' }]}>
            <Select
              placeholder="选择该地块下的苗木批次"
              options={plotSeedlings.map((row) => ({
                value: row.id,
                label: `${row.species} · ${row.spec} · ${row.quantity} 株（${row.source}）`,
              }))}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plantDate" label="栽植日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="spacingM"
              label="株距（米）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写株距' }]}
            >
              <InputNumber min={0.2} max={10} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="count" label="株数" style={{ flex: 1 }} rules={[{ required: true, message: '请填写株数' }]}>
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="作业班组" rules={[{ required: true, message: '请填写作业班组' }]}>
            <Input placeholder="如：东港一班" />
          </Form.Item>

          {density !== null ? (
            <Alert
              type={density.level === 'success' ? 'success' : density.level === 'warning' ? 'warning' : 'error'}
              showIcon
              message={`密度校验：${density.ok ? '合理' : '需要关注'}`}
              description={
                <span>
                  {density.message}
                  <br />
                  合理区间为 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT} ㎡/株。
                </span>
              }
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              填写株距与株数后会自动校验密度（合理区间 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT} ㎡/株）。
            </Typography.Text>
          )}
        </Form>
      </Modal>
    </div>
  );
}
