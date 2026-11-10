import accounts from './worker.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return accounts.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  }
};
