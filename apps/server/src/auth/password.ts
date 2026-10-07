import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

type ScryptOptions = { N: number; r: number; p: number; maxmem: number };
const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>;

const PARAMS: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }; // N=2^15는 기본 maxmem(32MB)을 넘는다
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const MIN_PASSWORD_LENGTH = 10;

// 저장 형식: scrypt$N$r$p$salt(base64)$hash(base64)
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

// 형식·길이·파라미터가 우리가 쓰는 것과 정확히 같을 때만 검증한다 (그 외는 모두 false)
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash, ...rest] = stored.split('$');
  if (algo !== 'scrypt' || rest.length > 0 || !salt || !hash) return false;
  if (Number(n) !== PARAMS.N || Number(r) !== PARAMS.r || Number(p) !== PARAMS.p) return false;
  const saltBytes = Buffer.from(salt, 'base64');
  const expected = Buffer.from(hash, 'base64');
  if (saltBytes.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = await scrypt(password, saltBytes, KEY_LENGTH, PARAMS);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
