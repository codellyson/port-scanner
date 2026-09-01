/**
 * Account and credential storage for the edge.
 *
 * Replaces the single shared `EDGE_TOKEN` with per-user tokens, so one abusive
 * or leaked credential can be revoked without cutting off everyone else. Uses
 * `node:sqlite` (Node >= 22.5) rather than a native driver, so deploying the
 * edge stays "rsync a dist/ and npm ci" with nothing to compile.
 *
 * Tokens are stored only as SHA-256 hashes. The raw value is returned exactly
 * once, at issue time, and is unrecoverable afterwards — a database read does
 * not hand the reader working credentials.
 */
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

export const TOKEN_PREFIX = 'pse_';

/** Concurrent tunnels a new account may hold. */
export const DEFAULT_MAX_TUNNELS = 3;

export type UserStatus = 'active' | 'blocked';

export interface User {
  id: string;
  provider: string;
  providerId: string;
  handle: string;
  status: UserStatus;
  maxTunnels: number;
  createdAt: number;
}

interface UserRow {
  id: string;
  provider: string;
  provider_id: string;
  handle: string;
  status: string;
  max_tunnels: number;
  created_at: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    provider: row.provider,
    providerId: row.provider_id,
    handle: row.handle,
    status: row.status === 'blocked' ? 'blocked' : 'active',
    maxTunnels: row.max_tunnels,
    createdAt: row.created_at,
  };
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL keeps a reader (an incoming agent) from blocking on a writer.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        provider     TEXT NOT NULL,
        provider_id  TEXT NOT NULL,
        handle       TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active',
        max_tunnels  INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_TUNNELS},
        created_at   INTEGER NOT NULL,
        UNIQUE (provider, provider_id)
      ) STRICT
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        hash         TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label        TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at   INTEGER
      ) STRICT
    `);

    // A tunnel id a user has claimed. Keeps someone else's chosen id from
    // being taken the moment their agent reconnects.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      ) STRICT
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id)');
  }

  /** Finds or creates the account behind an identity provider login. */
  upsertUser(provider: string, providerId: string, handle: string): User {
    const existing = this.db
      .prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?')
      .get(provider, providerId) as UserRow | undefined;

    if (existing) {
      if (existing.handle !== handle) {
        this.db
          .prepare('UPDATE users SET handle = ? WHERE id = ?')
          .run(handle, existing.id);
        existing.handle = handle;
      }
      return toUser(existing);
    }

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO users (id, provider, provider_id, handle, status, max_tunnels, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(id, provider, providerId, handle, DEFAULT_MAX_TUNNELS, Date.now());

    return this.userById(id)!;
  }

  userById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | UserRow
      | undefined;
    return row ? toUser(row) : null;
  }

  /**
   * Mints a token for a user. The returned string is the only copy — only its
   * hash is persisted.
   */
  issueToken(userId: string, label = 'default'): string {
    const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
    this.db
      .prepare(
        'INSERT INTO tokens (hash, user_id, label, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(hashToken(raw), userId, label, Date.now());
    return raw;
  }

  /**
   * Resolves a raw token to its account, or null when unknown or revoked.
   * Lookup is by hash, so a wrong guess reveals nothing through timing.
   */
  authenticate(raw: string): User | null {
    if (!raw) return null;

    const row = this.db
      .prepare(
        `SELECT u.* FROM tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.hash = ? AND t.revoked_at IS NULL`
      )
      .get(hashToken(raw)) as UserRow | undefined;

    if (!row) return null;

    this.db
      .prepare('UPDATE tokens SET last_used_at = ? WHERE hash = ?')
      .run(Date.now(), hashToken(raw));

    return toUser(row);
  }

  revokeToken(raw: string): boolean {
    const result = this.db
      .prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL')
      .run(Date.now(), hashToken(raw));
    return result.changes > 0;
  }

  /** Kill switch: blocks an account without deleting its history. */
  setStatus(userId: string, status: UserStatus): void {
    this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  }

  setMaxTunnels(userId: string, max: number): void {
    this.db.prepare('UPDATE users SET max_tunnels = ? WHERE id = ?').run(max, userId);
  }

  /** The account holding a tunnel id, if any. */
  idOwner(id: string): string | null {
    const row = this.db
      .prepare('SELECT user_id FROM reservations WHERE id = ?')
      .get(id) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  /**
   * Claims a tunnel id for a user. Returns false when someone else holds it —
   * callers should fall back to a random id rather than reusing it.
   */
  claimId(id: string, userId: string): boolean {
    const owner = this.idOwner(id);
    if (owner) return owner === userId;

    this.db
      .prepare('INSERT INTO reservations (id, user_id, created_at) VALUES (?, ?, ?)')
      .run(id, userId, Date.now());
    return true;
  }

  close(): void {
    this.db.close();
  }
}
