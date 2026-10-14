import { describe, expect, it } from 'vitest';
import { ingest } from '../src/services/ingest';
import { loggedInApp } from './helpers';

// 테이블 하나. options 는 `) ENGINE=InnoDB` 뒤에 그대로 붙는다
const table = (name: string, options = '') => `CREATE TABLE \`${name}\` (\n  \`id\` int NOT NULL,\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB${options};`;
const dump = (schema: string, tables: string[]) => [`/* Database : ${schema} */`, 'SET NAMES utf8mb4;', '', ...tables.flatMap((t) => [t, '']), ''].join('\n');
const GENERAL = ' DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';
const NINE = ' DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';
const LATIN1 = ' DEFAULT CHARSET=latin1';

async function setup(tables: string[]) {
  const ctx = await loggedInApp();
  const base = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: dump('shop', tables), userId: 1 });
  const suggest = async (id = base.versionId, headers: Record<string, string> = ctx.viewer) =>
    ctx.app.inject({ method: 'GET', url: `/api/versions/${id}/alter-defaults`, headers });
  return { ...ctx, baseId: base.versionId, suggest };
}

// ALTER 적용 대화상자의 스키마 기본값 제안: td-export 덤프에는 DB 기본값이 없으므로, 기준 버전 테이블의 DEFAULT CHARSET·COLLATE 최빈값을 돌려준다
describe('GET /versions/:id/alter-defaults', () => {
  it('테이블이 가장 많이 쓰는 문자셋·콜레이션 쌍을 돌려준다', async () => {
    const ctx = await setup([table('a', GENERAL), table('b', GENERAL), table('c', NINE)]);
    const res = await ctx.suggest();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } });
  });

  it('COLLATE 없이 DEFAULT CHARSET 만 있으면 그 문자셋의 기본 콜레이션을 쓴다', async () => {
    const ctx = await setup([table('a', LATIN1), table('b', LATIN1), table('c', NINE)]);
    expect((await ctx.suggest()).json()).toEqual({ defaults: { charset: 'latin1', collation: 'latin1_swedish_ci' } });
  });

  it('쓴 이름이 달라도 MySQL 표기로 맞춰 센다 (utf8 = utf8mb3)', async () => {
    const ctx = await setup([table('a', ' DEFAULT CHARSET=utf8'), table('b', ' DEFAULT CHARSET=utf8mb3'), table('c', NINE)]);
    expect((await ctx.suggest()).json()).toEqual({ defaults: { charset: 'utf8mb3', collation: 'utf8mb3_general_ci' } });
  });

  it('개수가 같으면 이름순으로 먼저 나온 테이블의 쌍을 돌려준다', async () => {
    const ctx = await setup([table('b', NINE), table('a', LATIN1)]);
    expect((await ctx.suggest()).json()).toEqual({ defaults: { charset: 'latin1', collation: 'latin1_swedish_ci' } });
  });

  it('옵션이 없는 테이블, 알 수 없는 문자셋, binary 는 세지 않는다', async () => {
    const ctx = await setup([
      table('a'), table('b'), table('c'),
      table('d', ' DEFAULT CHARSET=binary'), table('e', ' DEFAULT CHARSET=binary'),
      table('f', ' DEFAULT CHARSET=klingon'), table('g', ' DEFAULT CHARSET=klingon'),
      table('h', ' DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin'),
    ]);
    expect((await ctx.suggest()).json()).toEqual({ defaults: { charset: 'utf8mb4', collation: 'utf8mb4_bin' } });
  });

  it('문자셋을 알 수 있는 테이블이 없으면 defaults 는 null (호출한 쪽이 MySQL 기본값을 쓴다)', async () => {
    const ctx = await setup([table('a'), table('b', ' DEFAULT CHARSET=binary')]);
    const res = await ctx.suggest();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ defaults: null });
  });

  it('없는 버전은 404', async () => {
    const ctx = await setup([table('a', GENERAL)]);
    expect((await ctx.suggest(9999)).statusCode).toBe(404);
  });
});
