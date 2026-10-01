/**
 * 路由表：/plots、/plots/:id/seedlings、/plots/:id/plantings、/surveys、/replants
 * 层级路由支持直接深链访问（配合 nginx try_files 回退）；页面按路由懒加载自动分包。
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from 'antd';
import App from '../App';

const PlotList = lazy(() => import('../pages/PlotList'));
const SeedlingBoard = lazy(() => import('../pages/SeedlingBoard'));
const PlantingEntry = lazy(() => import('../pages/PlantingEntry'));
const SurveyBoard = lazy(() => import('../pages/SurveyBoard'));
const ReplantPlan = lazy(() => import('../pages/ReplantPlan'));

/** 路由路径常量：全项目唯一来源，避免手写字符串不一致 */
export const ROUTES = {
  plots: '/plots',
  seedlings: (plotId: string): string => `/plots/${plotId}/seedlings`,
  plantings: (plotId: string): string => `/plots/${plotId}/plantings`,
  surveys: '/surveys',
  replants: '/replants',
} as const;

/** 懒加载页面占位 */
function RouteFallback() {
  return <Skeleton active paragraph={{ rows: 6 }} style={{ background: '#ffffff', padding: 16, borderRadius: 10 }} />;
}

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.plots} replace /> },
      { path: 'plots', element: withSuspense(<PlotList />) },
      { path: 'plots/:id/seedlings', element: withSuspense(<SeedlingBoard />) },
      { path: 'plots/:id/plantings', element: withSuspense(<PlantingEntry />) },
      { path: 'surveys', element: withSuspense(<SurveyBoard />) },
      { path: 'replants', element: withSuspense(<ReplantPlan />) },
      { path: '*', element: <Navigate to={ROUTES.plots} replace /> },
    ],
  },
];

export default appRoutes;
