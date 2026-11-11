import '../src/quiet-warnings.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, buildApp, type AppOptions } from '../src/app.ts';
import { KeyStore } from '../src/auth.ts';

export const FIXTURES = join(REPO_ROOT, 'fixtures');
export const KEYS = { uploader: 'demo-uploader-key', reviewer: 'demo-reviewer-key', admin: 'demo-admin-key' } as const;
export type Who = keyof typeof KEYS;

export function multipart(fields: Record<string, string>, file: { name: string; content: Buffer }) {
  const boundary = '----test' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
  );
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** A test harness around buildApp: authenticated requests, uploads, and waiting for the worker. */
export async function harness(overrides: Partial<AppOptions> = {}) {
  const dataDir = overrides.dataDir ?? mkdtempSync(join(tmpdir(), 'feed-api-'));
  const built = await buildApp({
    dbPath: ':memory:',
    dataDir,
    keys: KeyStore.fromFile(join(REPO_ROOT, 'config', 'api-keys.demo.json')),
    partnersFile: join(FIXTURES, 'partners.json'),
    ...overrides,
  });
  await built.app.ready();
  const auth = (who: Who | null) => (who ? { authorization: `Bearer ${KEYS[who]}` } : {});

  const h = {
    ...built,
    dataDir,
    async req(who: Who | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
      const res = await built.app.inject({ method, url, headers: auth(who), ...(payload !== undefined ? { payload: payload as object } : {}) });
      return { status: res.statusCode, body: res.headers['content-type']?.toString().includes('json') ? res.json() : res.body, headers: res.headers };
    },
    async upload(who: Who | null, path: string, fields: Record<string, string>, content?: Buffer) {
      const mp = multipart(fields, { name: path.split('/').pop()!, content: content ?? readFileSync(join(FIXTURES, path)) });
      const res = await built.app.inject({ method: 'POST', url: '/api/runs', payload: mp.payload, headers: { ...mp.headers, ...auth(who) } });
      return { status: res.statusCode, body: res.json() };
    },
    /** Upload and wait until the worker has finished with the run. */
    async ingest(who: Who, path: string, fields: Record<string, string>) {
      const up = await h.upload(who, path, fields);
      if (up.status !== 202) return up;
      await built.runs.idle();
      return h.req(who, 'GET', `/api/runs/${up.body.id}`);
    },
    async settle(runId: string) {
      await built.runs.idle();
      return h.req('reviewer', 'GET', `/api/runs/${runId}`);
    },
  };
  return h;
}
