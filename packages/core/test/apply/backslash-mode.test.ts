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
});
