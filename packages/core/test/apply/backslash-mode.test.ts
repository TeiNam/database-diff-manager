import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// NO_BACKSLASH_ESCAPES: 문장 나누기(splitDump)가 따라가는 SQL_MODE 와 SET 문이 바꾼 세션 SQL_MODE 가 다르면, 백슬래시가 든 문장을 MySQL 과 다른 문자열로 읽는다.
// 그런 문장은 저장하지 않고 거부한다. 같은 모드로 읽은 COMMENT·DEFAULT 의 백슬래시는 MySQL 과 같게 남지만 (8.4.11 실측), ENUM·SET 값은 타입 정규화가 보통 규칙으로 다시 읽어 거부한다
const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n')).model;
const run = (script: string) => applyScript(base, script, { schemaName: 'shop' });
const reasonOf = (script: string): string => {
  const r = run(script);
  return r.ok ? 'ok' : `${r.error.index}: ${r.error.reason}`;
};

describe('NO_BACKSLASH_ESCAPES — 문장 나누기와 세션 SQL_MODE 가 어긋날 때', () => {
  it.each([
    "SET @@sql_mode = 'NO_BACKSLASH_ESCAPES';",
    "SET @@session.sql_mode = 'NO_BACKSLASH_ESCAPES';",
    "SET sql_mode := 'NO_BACKSLASH_ESCAPES';",
    'SET sql_mode = "NO_BACKSLASH_ESCAPES";',
    "SET @m = 'NO_BACKSLASH_ESCAPES';\nSET sql_mode = @m;",
  ])('%s 뒤의 백슬래시가 든 문장은 RE_EXPORT 로 거부하고, 백슬래시가 없는 문장은 받는다', (set) => {
    const statements = set.split('\n').length;
    const reason = reasonOf(`${set}\nALTER TABLE t COMMENT 'C:\\path';`);
    expect(reason).toMatch(new RegExp(`^${statements + 1}: `));
    expect(reason.endsWith(RE_EXPORT), reason).toBe(true);
    expect(reasonOf(`${set}\nALTER TABLE t ADD c INT;`)).toBe('ok');
  });

  it("둘 다 따라가는 SET SQL_MODE = '…' 는 그대로 받는다: COMMENT·DEFAULT 의 백슬래시는 글자 그대로다", () => {
    const r = run("SET SQL_MODE = 'NO_BACKSLASH_ESCAPES';\nALTER TABLE t COMMENT 'C:\\path', ADD c VARCHAR(10) DEFAULT 'a\\b' COMMENT 'x\\y';");
    if (!r.ok) throw new Error(r.error.reason);
    const t = r.model.tables[0];
    expect(t.options.find((o) => o.key === 'COMMENT')?.value).toBe("'C:\\\\path'");
    expect(t.columns[1]).toMatchObject({ default: "'a\\\\b'", comment: 'x\\y' });
  });

  it('ENUM·SET 값의 백슬래시는 RE_EXPORT 로 거부한다 (보통 모드에서는 받는다)', () => {
    for (const type of ["ENUM('a\\n','b')", "SET('a\\\\b','c')"]) {
      const reason = reasonOf(`SET SQL_MODE = 'NO_BACKSLASH_ESCAPES';\nALTER TABLE t ADD e ${type};`);
      expect(reason).toMatch(/^2: /);
      expect(reason.endsWith(RE_EXPORT), reason).toBe(true);
      expect(reasonOf(`ALTER TABLE t ADD e ${type};`)).toBe('ok');
    }
  });

  // ENUM( 마다 짝 괄호까지 다시 훑으면 중첩 괄호에서 제곱 시간이다 (리뷰 1회차 M-2: 중첩 4만 개 4.4 초, 8만 개 16 초). 토큰을 한 번만 돌며 열린 ENUM·SET 인자 괄호를 센다
  it('ENUM·SET 백슬래시 검사는 중첩 괄호에서도 선형이고, 중첩 안·뒤의 값도 본다', () => {
    const nested = 40000;
    const started = performance.now();
    const reason = reasonOf(`SET SQL_MODE = 'NO_BACKSLASH_ESCAPES';\nALTER TABLE t ADD c ${'ENUM('.repeat(nested)}${')'.repeat(nested)};`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(reason).toMatch(/^2: ENUM·SET 값은 문자열이어야 합니다/);
    for (const type of ["ENUM(SET('a\\b'), 'c')", "ENUM(x(1), 'a\\b')", "SET('a', ENUM('b'), 'c\\d')"]) {
      const r = reasonOf(`SET SQL_MODE = 'NO_BACKSLASH_ESCAPES';\nALTER TABLE t ADD e ${type};`);
      expect(r.endsWith(RE_EXPORT), `${type}: ${r}`).toBe(true);
    }
    expect(reasonOf("SET SQL_MODE = 'NO_BACKSLASH_ESCAPES';\nALTER TABLE t ADD e ENUM('a','b') COMMENT 'x\\y';")).toBe('ok'); // ENUM 인자 밖의 백슬래시는 그대로 받는다
  });
});
