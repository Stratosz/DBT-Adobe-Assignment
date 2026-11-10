import './quiet-warnings.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { REPO_ROOT, buildApp } from './app.ts';

const dataDir = process.env.DATA_DIR ?? join(REPO_ROOT, 'data');
mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT ?? 3000);
const pretty = process.stdout.isTTY && process.env.LOG_FORMAT !== 'json';

const { app } = await buildApp({
  dbPath: process.env.DB_PATH ?? join(dataDir, 'feed.db'),
  dataDir,
  partnersFile: join(REPO_ROOT, 'fixtures', 'partners.json'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  },
});

// In "npm start" mode the API also serves the built UI.
const webDist = join(REPO_ROOT, 'apps', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }) : reply.sendFile('index.html')));
}

await app.listen({ port, host: '0.0.0.0' });
