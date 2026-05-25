import { ModuleLoader } from './ModuleLoader';

export function registerCoreModules(): void {
  const loader = ModuleLoader.getInstance();

  loader.register({
    id: 'notifications',
    activation: 'login',
    routes: ['/notifications'],
    load: () => import('../modules/notifications/runtime').then(m => m.default),
  });

  loader.register({
    id: 'dms',
    activation: 'login',
    routes: ['/messages', '/conversation'],
    load: () => import('../modules/dms/runtime').then(m => m.default),
  });

  loader.register({
    id: 'reactions',
    activation: 'login',
    load: () => import('../modules/reactions/runtime').then(m => m.default),
  });

  loader.register({
    id: 'zaps',
    activation: 'login',
    load: () => import('../modules/zaps/runtime').then(m => m.default),
  });
}
