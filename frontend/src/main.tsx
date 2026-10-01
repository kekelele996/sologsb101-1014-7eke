import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles/main.css';
import { appRoutes } from './router';

const theme = {
  token: {
    colorPrimary: '#0f766e',
    colorInfo: '#0f766e',
    colorSuccess: '#1f8a4c',
    colorWarning: '#d08700',
    colorError: '#c0392b',
    colorTextBase: '#20302b',
    borderRadius: 8,
    fontFamily:
      '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", system-ui, sans-serif',
  },
  components: {
    Layout: { headerBg: '#ffffff', siderBg: '#0d3b36' },
    Card: { headerBg: '#f7fbfa' },
    Table: { headerBg: '#f1f7f5' },
  },
};

const container = document.getElementById('root');
if (container === null) {
  throw new Error('未找到 #root 挂载节点');
}

const router = createBrowserRouter(appRoutes);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
