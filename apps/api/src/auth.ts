import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * API-key authentication with three roles (feedback round 1, InfoSec finding #1).
 *
 *   uploader  upload files, view runs, download set-aside rows
 *   reviewer  + confirm mappings, approve/reject held runs, override the bad-row limit, read the audit log
 *   admin     + edit/delete saved supplier mappings, read /metrics
 *
 * Keys are stored only as SHA-256 hashes and compared in constant time. This is the pilot
 * solution; production would put the API behind the company SSO (OIDC) and map IdP groups
 * to the same roles (see docs/adr/0005-api-keys-and-roles.md).
 */
export const ROLES = ['uploader', 'reviewer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

interface KeyEntry extends Actor {
  keyHash: string;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export class KeyStore {
  private readonly entries: { actor: Actor; hash: Buffer }[];

  constructor(entries: KeyEntry[]) {
    for (const e of entries) {
      if (!ROLES.includes(e.role)) throw new Error(`API key "${e.id}" has unknown role "${e.role}"`);
      if (!/^[a-f0-9]{64}$/.test(e.keyHash)) throw new Error(`API key "${e.id}" must store a SHA-256 hex hash, not the key`);
    }
    this.entries = entries.map(({ keyHash, ...actor }) => ({ actor, hash: Buffer.from(keyHash, 'hex') }));
  }

  static fromFile(path: string): KeyStore {
    return new KeyStore(JSON.parse(readFileSync(path, 'utf8')) as KeyEntry[]);
  }

  /** Compare against every entry (no early exit) so timing does not reveal which keys exist. */
  authenticate(presented: string): Actor | null {
    const candidate = Buffer.from(hashKey(presented), 'hex');
    let match: Actor | null = null;
    for (const e of this.entries) {
      if (timingSafeEqual(candidate, e.hash) && !match) match = e.actor;
    }
    return match;
  }
}

export function atLeast(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export class AuthError extends Error {
  constructor(
    readonly statusCode: 401 | 403,
    readonly code: string,
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/** Fastify onRequest hook body: resolves the actor from `Authorization: Bearer <key>`. */
export function resolveActor(keys: KeyStore, req: FastifyRequest): Actor | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S{8,200})$/i.exec(header);
  if (!match) return null;
  return keys.authenticate(match[1]!);
}

/** preHandler factory: `{ preHandler: requireRole('reviewer') }` */
export function requireRole(role: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.actor) {
      reply.header('www-authenticate', 'Bearer realm="feed-intake"');
      req.log.warn({ event: 'auth.missing_or_invalid', ip: req.ip, url: req.url }, 'unauthenticated request');
      throw new AuthError(401, 'UNAUTHENTICATED', 'A valid API key is required', 'Send the header "Authorization: Bearer <api key>".');
    }
    if (!atLeast(req.actor.role, role)) {
      req.log.warn({ event: 'auth.forbidden', actor: req.actor.id, role: req.actor.role, required: role, url: req.url }, 'forbidden');
      throw new AuthError(403, 'FORBIDDEN', `This action needs the ${role} role; you are signed in as ${req.actor.role}`, `Ask an admin for a ${role} key.`);
    }
  };
}
