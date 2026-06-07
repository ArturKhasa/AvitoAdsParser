// pm2 start ecosystem.config.cjs
// pm2 delete all && pm2 start ecosystem.config.cjs

const WORKER_COUNT = 30; // Количество параллельных воркеров

module.exports = {
  apps: Array.from({ length: WORKER_COUNT }, (_, i) => ({
    name: `creative-${i}`,
    script: 'scripts/fetch-creative.mjs',
    restart_delay: 5000,
    env: {
      WORKER_INDEX: String(i),
      WORKER_COUNT: String(WORKER_COUNT),
    },
  })),
};
