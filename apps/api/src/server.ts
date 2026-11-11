import './quiet-warnings.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
// Loaded after quiet-warnings is installed: built-in modules (node:sqlite) are instantiated
// before any module body runs, so a static import would print the warning first.
const { REPO_ROOT, buildApp } = await import('./app.ts');
const { KeyStore } = await import('./auth.ts');

/** Configuration is validated once at startup; a bad value fails fast with a clear message. */
const DEMO_KEYS = join(REPO_ROOT, 'config', 'api-keys.demo.json');
const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default(join(REPO_ROOT, 'data')),
  DB_PATH: z.string().optional(),
  API_KEYS_FILE: z.string().default(DEMO_KEYS),
  ALLOW_DEMO_KEYS: z.enum(['true', 'false']).default('false'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2048).default(250),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(25_000),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
const env = parsed.data;

const usingDemoKeys = resolve(env.API_KEYS_FILE) === resolve(DEMO_KEYS);
if (usingDemoKeys && env.NODE_ENV === 'production' && env.ALLOW_DEMO_KEYS !== 'true') {
  console.error('Refusing to start: production mode with the public demo API keys. Set API_KEYS_FILE (or ALLOW_DEMO_KEYS=true for a demo deployment).');
  process.exit(1);
}

mkdirSync(env.DATA_DIR, { recursive: true });
const pretty = env.LOG_FORMAT ? env.LOG_FORMAT === 'pretty' : process.stdout.isTTY;

const { app } = await buildApp({
  dbPath: env.DB_PATH ?? join(env.DATA_DIR, 'feed.db'),
  dataDir: env.DATA_DIR,
  keys: KeyStore.fromFile(env.API_KEYS_FILE),
  partnersFile: join(REPO_ROOT, 'fixtures', 'partners.json'),
  maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
  logger: {
    level: env.LOG_LEVEL,
    // Never log credentials, even by accident.
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  },
});
if (usingDemoKeys) app.log.warn('Using the public demo API keys from config/api-keys.demo.json. Do not use them outside a demo.');

// In "npm start" / Docker the API also serves the built UI.
const webDist = join(REPO_ROOT, 'apps', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api') ? reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }) : reply.sendFile('index.html'),
  );
}

// Graceful shutdown: stop accepting requests, let the current run finish (bounded), close the DB.
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down: finishing the current run, then exiting');
    const timer = setTimeout(() => {
      app.log.error('shutdown timed out; exiting (the interrupted run is recovered on next start)');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS + 5_000).unref();
    await app.close();
    clearTimeout(timer);
    process.exit(0);
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
