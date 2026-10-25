import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hmacSha256Hex = (key: string | Buffer, data: string | Buffer) =>
  createHmac('sha256', key).update(data).digest('hex');

/** Constant-time string comparison (false on length mismatch). */
export function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Random URL-safe token with a recognisable prefix, e.g. `agrt_…`. */
export function generateToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

/** Parse a 32-byte key given as base64 (std or url) or hex. */
export function parseKey(raw: string): Buffer {
  const s = raw.trim();
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s))
    buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf?.length !== 32) {
    throw new Error(
      'AGENTS_ENCRYPTION_KEY must be 32 bytes encoded as base64 or hex (e.g. `openssl rand -base64 32`)',
    );
  }
  return buf;
}

const keyIdOf = (key: Buffer) => sha256Hex(key).slice(0, 8);

/**
 * AES-256-GCM envelope for secrets at rest.
 *
 * Payload format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts). The
 * associated data (AAD) binds a ciphertext to its owner (e.g. `org:agent:integration`),
 * so a row copied onto another agent fails to decrypt. Several keys may be loaded
 * for rotation: the first encrypts, any of them decrypts (matched by key id).
 */
export class SecretBox {
  private readonly keys: { id: string; key: Buffer }[];

  constructor(keys: Buffer[]) {
    if (!keys.length) throw new Error('SecretBox needs at least one key');
    this.keys = keys.map((key) => {
      if (key.length !== 32) throw new Error('SecretBox keys must be 32 bytes');
      return { id: keyIdOf(key), key };
    });
  }

  /**
   * Build from env. Without a key: fails in production; elsewhere uses an
   * ephemeral random key (credentials will not survive a restart) and reports it.
   */
  static fromEnv(opts: { key?: string; previousKey?: string; production: boolean }): {
    box: SecretBox;
    ephemeral: boolean;
  } {
    if (!opts.key) {
      if (opts.production) throw new Error('AGENTS_ENCRYPTION_KEY is required in production');
      return { box: new SecretBox([randomBytes(32)]), ephemeral: true };
    }
    const keys = [parseKey(opts.key)];
    if (opts.previousKey) keys.push(parseKey(opts.previousKey));
    return { box: new SecretBox(keys), ephemeral: false };
  }

  get keyId(): string {
    return this.keys[0]!.id;
  }

  encrypt(plaintext: string, aad: string): string {
    const { id, key } = this.keys[0]!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', id, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(
      '.',
    );
  }

  decrypt(payload: string, aad: string): string {
    const [version, kid, ivB64, tagB64, ctB64] = payload.split('.');
    if (version !== 'v1' || !kid || !ivB64 || !tagB64 || ctB64 === undefined)
      throw new Error('Malformed encrypted payload');
    const entry = this.keys.find((k) => k.id === kid);
    if (!entry)
      throw new Error(
        'Encrypted with an unknown key (was AGENTS_ENCRYPTION_KEY rotated without keeping the previous key?)',
      );
    const decipher = createDecipheriv('aes-256-gcm', entry.key, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T = unknown>(payload: string, aad: string): T {
    return JSON.parse(this.decrypt(payload, aad)) as T;
  }
}

/** Mask a secret for display: `••••abcd` (last 4 shown only for values long enough not to leak them). */
export function maskSecret(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length >= 12) return `••••${s.slice(-4)}`;
  return '••••';
}

export function maskRecord(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = maskSecret(v);
  }
  return out;
}
