/**
 * 应用外壳：左侧导航 + 顶部当前地块上下文 + 内容区 + 页脚
 * 同时负责本地数据库初始化与全局 store 的数据订阅。
 */
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Button, Layout, Menu, Space, Tag, Typography } from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { ROUTES } from './router';
import { usePlotStore } from './stores/plotStore';
import { useReplantStore } from './stores/replantStore';
import { useSurveyStore } from './stores/surveyStore';
import { percentText } from './utils/rate';

const { Header, Sider, Content, Footer } = Layout;

/** 按当前路径推导高亮的导航项 */
function selectedKey(pathname: string): string {
  if (pathname.startsWith('/plots/')) return ROUTES.plots;
  if (pathname.startsWith('/surveys')) return ROUTES.surveys;
  if (pathname.startsWith('/replants')) return ROUTES.replants;
  return ROUTES.plots;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const plots = usePlotStore((state) => state.plots);
  const counts = usePlotStore((state) => state.counts);
  const currentPlotId = usePlotStore((state) => state.currentPlotId);
  const statOf = usePlotStore((state) => state.statOf);
  const error = usePlotStore((state) => state.error);
  const loadAll = usePlotStore((state) => state.loadAll);
  const initSurvey = useSurveyStore((state) => state.init);
  const initReplant = useReplantStore((state) => state.init);

  useEffect(() => {
    void loadAll();
    void initSurvey();
    void initReplant();
  }, [loadAll, initSurvey, initReplant]);

  const currentPlot = plots.find((plot) => plot.id === currentPlotId) ?? null;
  const currentStat = currentPlot === null ? null : statOf(currentPlot.id);

  return (
    <Layout style={{ minHeight: '100vh', background: '#f2f7f5' }}>
      <Sider width={228} breakpoint="lg" collapsedWidth={0} style={{ background: '#0d3b36' }}>
        <div style={{ padding: '18px 16px 10px' }}>
          <Typography.Title level={5} style={{ color: '#d9f2e6', margin: 0 }}>
            红树林修复成活率跟踪台
          </Typography.Title>
          <Typography.Text style={{ color: 'rgba(217,242,230,0.6)', fontSize: 12 }}>
            gbmangrove · 修复地块数字化台账
          </Typography.Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey(location.pathname)]}
          style={{ background: 'transparent' }}
          onClick={({ key }) => navigate(key)}
          items={[
            { key: ROUTES.plots, icon: <AppstoreOutlined />, label: '修复地块台账' },
            { key: ROUTES.surveys, icon: <ExperimentOutlined />, label: '成活率验收台' },
            { key: ROUTES.replants, icon: <ToolOutlined />, label: '补植计划' },
          ]}
        />
        <div style={{ padding: '12px 16px', color: 'rgba(217,242,230,0.62)', fontSize: 12, lineHeight: 1.9 }}>
          <div>
            <DashboardOutlined /> 地块 {counts.plots ?? 0} · 批次 {counts.seedlings ?? 0}
          </div>
          <div>
            <BarChartOutlined /> 栽植 {counts.plantings ?? 0} · 验收 {counts.surveys ?? 0}
          </div>
          <div>
            <ToolOutlined /> 补植 {counts.replants ?? 0} · 结构 v{String(counts.schemaVersion ?? '-')}
          </div>
        </div>
      </Sider>

      <Layout style={{ background: '#f2f7f5' }}>
        <Header
          style={{
            background: '#ffffff',
            borderBottom: '1px solid rgba(15,118,110,0.14)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 20,
            gap: 12,
            flexWrap: 'wrap',
            height: 'auto',
            lineHeight: 'normal',
            paddingBlock: 10,
          }}
        >
          <Space size={10} wrap>
            <Typography.Text strong>当前地块：</Typography.Text>
            {currentPlot !== null && currentStat !== null ? (
              <>
                <Tag color="#0f766e">{currentPlot.name}</Tag>
                <Tag>{currentPlot.areaMu} 亩</Tag>
                <Tag>{currentPlot.tideZone}潮位带 / {currentPlot.substrate}</Tag>
                <Tag color="blue">栽植 {currentStat.plantTotal.toLocaleString('zh-CN')} 株</Tag>
                <Tag color={currentStat.surveyCount === 0 ? 'default' : 'green'}>
                  {currentStat.surveyCount === 0 ? '尚未验收' : `成活率 ${percentText(currentStat.latestRate)}`}
                </Tag>
                <Tag color={currentPlot.missingCount > 0 ? 'orange' : 'green'}>缺株 {currentPlot.missingCount} 株</Tag>
              </>
            ) : (
              <Tag>未选择地块</Tag>
            )}
          </Space>
          <Space>
            {currentPlot !== null ? (
              <>
                <Button size="small" onClick={() => navigate(ROUTES.seedlings(currentPlot.id))}>
                  苗木批次
                </Button>
                <Button size="small" onClick={() => navigate(ROUTES.plantings(currentPlot.id))}>
                  栽植记录
                </Button>
              </>
            ) : null}
            <Badge count={counts.surveys ?? 0} showZero color="#0f766e" title="验收记录总数" />
          </Space>
        </Header>

        <Content style={{ padding: 20, minHeight: 320 }}>
          {error !== '' ? (
            <div style={{ marginBottom: 12, color: '#c0392b' }}>本地数据库错误：{error}</div>
          ) : null}
          <Outlet />
        </Content>

        <Footer style={{ textAlign: 'center', background: 'transparent', color: 'rgba(0,0,0,0.45)' }}>
          数据仅保存在本机浏览器（IndexedDB 库名 gbmangrove / localStorage），不上传任何服务器 ·
          <Link to={ROUTES.plots} style={{ marginLeft: 6 }}>
            返回地块台账
          </Link>
        </Footer>
      </Layout>
    </Layout>
  );
}
