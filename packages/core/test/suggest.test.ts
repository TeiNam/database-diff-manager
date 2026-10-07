import { describe, expect, it } from 'vitest';
import { suggestTarget } from '../src/suggest';

describe('suggestTarget', () => {
  it('td-export SQL 파일명과 헤더', () => {
    expect(suggestTarget('sample-app(10.0.0.15).sql', '/* Database : sample-app */\nCREATE TABLE …')).toEqual({
      format: 'sql', schemaName: 'sample-app', databaseName: '10.0.0.15',
    });
  });

  it('td-export 0.1.20+ 파일명 host_port는 Database를 host:port로 제안한다', () => {
    expect(suggestTarget('sample-app(10.0.0.15_3309).sql', '/* Database : sample-app */\nSET @OLD_FOREIGN_KEY_CHECKS = 0;')).toEqual({
      format: 'sql', schemaName: 'sample-app', databaseName: '10.0.0.15:3309',
    });
    expect(suggestTarget('sample-app(10.0.0.15_3309).md', 'sample-app \n=============\n')).toEqual({
      format: 'md', schemaName: 'sample-app', databaseName: '10.0.0.15:3309',
    });
  });

  it('포트로 볼 수 없는 _ 꼬리는 그대로 둔다', () => {
    expect(suggestTarget('s(db_01).sql', '').databaseName).toBe('db_01');
    expect(suggestTarget('s(db_99999).sql', '').databaseName).toBe('db_99999');
    expect(suggestTarget('s(my_host).sql', '').databaseName).toBe('my_host');
    expect(suggestTarget('s(db_2).sql', '').databaseName).toBe('db_2'); // 100 미만은 포트로 보지 않는다
    expect(suggestTarget('s(h_3309).sql', '').databaseName).toBe('h:3309');
  });

  it('td-export 0.1.15 MD 파일명과 첫 줄', () => {
    expect(suggestTarget('shop(db-01).md', 'shop \n=============\n')).toEqual({ format: 'md', schemaName: 'shop', databaseName: 'db-01' });
  });

  it('엔드포인트 없는 파일명은 schema만 제안한다 (경로·BOM 제거)', () => {
    expect(suggestTarget('a/b/shop.md', '\uFEFFshop\n')).toEqual({ format: 'md', schemaName: 'shop' });
  });

  it('본문 헤더가 파일명보다 우선한다', () => {
    expect(suggestTarget('renamed(db).sql', '/* Database : real */')).toEqual({ format: 'sql', schemaName: 'real', databaseName: 'db' });
  });

  it('지원하지 않는 형식은 빈 결과', () => {
    expect(suggestTarget('10.0.0.15.xlsx', '')).toEqual({});
  });
});
