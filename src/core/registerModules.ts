import { ModuleLoader } from './ModuleLoader';

export function registerCoreModules(): void {
  const loader = ModuleLoader.getInstance();

  loader.register({
    id: 'notifications',
    activation: 'login',
    routes: ['/notifications'],
    load: () => import('../modules/notifications/runtime').then(m => m.default),
  });
}
