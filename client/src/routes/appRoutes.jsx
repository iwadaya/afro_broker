import { lazy } from 'react';

const LoginScreen = lazy(() => import('../screens/login/LoginScreen'));
const HomeScreen = lazy(() => import('../screens/home/HomeScreen'));
// Broking module routes (client/src/broking) — only reachable when BROKING_ENABLED is on.
const BrokingRoutes = lazy(() => import('../broking/BrokingRoutes'));

export const appRoutes = [
  { path: '/login', component: LoginScreen, public: true },
  { path: '/', component: HomeScreen },
  { path: '/broking/*', component: BrokingRoutes, broking: true },
];
