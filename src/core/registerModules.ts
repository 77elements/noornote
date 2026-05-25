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

  loader.register({
    id: 'posts',
    activation: 'login',
    load: () => import('../modules/posts/runtime').then(m => m.default),
  });

  loader.register({
    id: 'media',
    activation: 'manual',
    load: () => import('../modules/media/runtime').then(m => m.default),
  });

  loader.register({
    id: 'articles',
    activation: 'route',
    routes: ['/article', '/write-article', '/edit-article'],
    load: () => import('../modules/articles/runtime').then(m => m.default),
  });

  loader.register({
    id: 'search',
    activation: 'route',
    routes: ['/search'],
    load: () => import('../modules/search/runtime').then(m => m.default),
  });

  loader.register({
    id: 'relay-browser',
    activation: 'route',
    routes: ['/relay'],
    sleepPolicy: 'sleep-on-leave',
    load: () => import('../modules/relay-browser/runtime').then(m => m.default),
  });
}
