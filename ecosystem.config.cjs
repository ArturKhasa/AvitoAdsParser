// pm2 start ecosystem.config.cjs
// pm2 delete all && pm2 start ecosystem.config.cjs

const fs = require('node:fs');

const WORKER_COUNT = Number(process.env.WORKER_COUNT ?? 10); // Количество параллельных воркеров

// Настройки БД парсер берёт из .env бэкенда, если он есть на этой машине.
const BACKEND_ENV_PATH = process.env.BACKEND_ENV_PATH ?? '/var/www/avimaps/.env';
const hasBackendEnv = fs.existsSync(BACKEND_ENV_PATH);

module.exports = {
  apps: Array.from({ length: WORKER_COUNT }, (_, i) => ({
    name: `creative-${i}`,
    script: 'scripts/fetch-creative.mjs',
    restart_delay: 5000,
    max_memory_restart: '250M',
    env: {
      WORKER_INDEX: String(i),
      WORKER_COUNT: String(WORKER_COUNT),
      ...(hasBackendEnv ? { BACKEND_ENV_PATH } : {}),
    },
  })),
};
