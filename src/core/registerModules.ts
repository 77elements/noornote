import { ModuleLoader } from './ModuleLoader';

export function registerCoreModules(): void {
  const loader = ModuleLoader.getInstance();

  loader.register({
    id: 'notifications',
    activation: 'login',
    load: () => import('../modules/notifications/runtime').then(m => m.default),
  });

  loader.register({
    id: 'dms',
    activation: 'login',
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

  loader.register({
    id: 'posts',
    activation: 'login',
    load: () => import('../modules/posts/runtime').then(m => m.default),
  });

  loader.register({
    id: 'media',
    activation: 'login',
    load: () => import('../modules/media/runtime').then(m => m.default),
  });

  loader.register({
    id: 'articles',
    activation: 'login',
    load: () => import('../modules/articles/runtime').then(m => m.default),
  });

  loader.register({
    id: 'search',
    activation: 'login',
    load: () => import('../modules/search/runtime').then(m => m.default),
  });

  loader.register({
    id: 'relay-browser',
    activation: 'login',
    load: () => import('../modules/relay-browser/runtime').then(m => m.default),
  });

  loader.register({
    id: 'settings',
    activation: 'login',
    load: () => import('../modules/settings/runtime').then(m => m.default),
  });

  loader.register({
    id: 'timeline',
    activation: 'login',
    load: () => import('../modules/timeline/runtime').then(m => m.default),
  });

  loader.register({
    id: 'profile',
    activation: 'login',
    load: () => import('../modules/profile/runtime').then(m => m.default),
  });

  loader.register({
    id: 'single-note',
    activation: 'login',
    load: () => import('../modules/single-note/runtime').then(m => m.default),
  });
}
