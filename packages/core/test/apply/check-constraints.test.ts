import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { sortChecks } from '../../src/apply/keys';
import type { Check, SchemaModel } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 기존 CHECK 는 모델에 있다 (CHECK 를 더하는 문장은 범위 밖이지만 td-export 덤프에는 CHECK 가 있다).
// MySQL 8.0.46·8.4.11 실측: 컬럼을 지우면 그 컬럼만 쓰는 CHECK 는 함께 사라지고 (이름을 붙인 것도, 컬럼을 같은 이름으로 다시 더해도),
// 다른 컬럼도 쓰는 CHECK 는 3959 다 (그 CHECK 의 컬럼을 모두 지워도). 이름을 바꾸는 RENAME COLUMN·CHANGE 는 CHECK 가 하나 컬럼만 써도 3959 다
const tableSql = (...checks: string[]): string => [
  'CREATE TABLE `chk` (\n  `id` int NOT NULL,\n  `price` decimal(10,2) NOT NULL,\n  `qty` int NOT NULL,\n  `note` varchar(20) DEFAULT NULL,\n  PRIMARY KEY (`id`)',
  ...checks.map((c) => `,\n  ${c}`),
  '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('');
const SOLE = parseSqlDump(tdExport(tableSql('CONSTRAINT `chk_chk_1` CHECK ((`qty` >= 0))', 'CONSTRAINT `chk_price` CHECK ((`price` > 0))'))).model;
const MULTI = parseSqlDump(tdExport(tableSql('CONSTRAINT `chk_chk_1` CHECK ((`qty` >= 0))', 'CONSTRAINT `chk_two` CHECK ((`price` > `qty`))'))).model;

const run = (base: SchemaModel, script: string) => applyScript(base, script, { schemaName: 'shop' });
const checksOf = (base: SchemaModel, script: string): string[] => {
  const r = run(base, script);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r.model.tables[0].checks.map((k) => k.name);
};
const reasonOf = (base: SchemaModel, script: string): string => {
  const r = run(base, script);
  if (r.ok) throw new Error(`적용되어 버렸다: ${script}`);
  return r.error.reason;
};

describe('컬럼을 지우면 그 컬럼만 쓰는 CHECK 도 사라진다', () => {
  it('자동 이름·직접 붙인 이름 모두, 다른 CHECK 는 남는다', () => {
    expect(checksOf(SOLE, 'ALTER TABLE chk DROP COLUMN qty;')).toEqual(['chk_price']);
    expect(checksOf(SOLE, 'ALTER TABLE chk DROP COLUMN price;')).toEqual(['chk_chk_1']);
    expect(checksOf(SOLE, 'ALTER TABLE chk DROP COLUMN qty, DROP COLUMN price;')).toEqual([]);
    expect(checksOf(SOLE, 'ALTER TABLE chk DROP COLUMN note;')).toEqual(['chk_chk_1', 'chk_price']); // 쓰지 않는 컬럼은 상관없다
  });

  it('지우고 같은 이름으로 다시 더한 컬럼에도 CHECK 는 따라오지 않는다', () => {
    expect(checksOf(SOLE, 'ALTER TABLE chk DROP COLUMN qty, ADD COLUMN qty INT;')).toEqual(['chk_price']);
  });

  it('지운 컬럼 자리에 다른 컬럼이 CHANGE 로 그 이름을 이어받아도 CHECK 는 사라진 채다', () => {
    expect(checksOf(SOLE, 'ALTER TABLE chk DROP COLUMN qty, CHANGE note qty VARCHAR(20);')).toEqual(['chk_price']);
  });

  it('다른 컬럼도 쓰는 CHECK 는 3959 — 그 CHECK 의 컬럼을 모두 지워도, 같은 문장에서 CHECK 를 지우면 된다', () => {
    expect(reasonOf(MULTI, 'ALTER TABLE chk DROP COLUMN qty;')).toContain('3959');
    expect(reasonOf(MULTI, 'ALTER TABLE chk DROP COLUMN price;')).toContain('3959');
    expect(reasonOf(MULTI, 'ALTER TABLE chk DROP COLUMN price, DROP COLUMN qty;')).toContain('3959');
    expect(checksOf(MULTI, 'ALTER TABLE chk DROP CHECK chk_two, DROP COLUMN price;')).toEqual(['chk_chk_1']);
    expect(checksOf(MULTI, 'ALTER TABLE chk DROP COLUMN price, DROP CONSTRAINT chk_two;')).toEqual(['chk_chk_1']);
    expect(checksOf(MULTI, 'ALTER TABLE chk DROP CHECK chk_two, DROP COLUMN price, DROP COLUMN qty;')).toEqual([]);
  });
});

describe('컬럼 이름을 바꾸면 CHECK 가 쓰는 컬럼은 3959', () => {
  it.each([
    ['ALTER TABLE chk RENAME COLUMN qty TO amount;'],
    ['ALTER TABLE chk CHANGE qty amount INT NOT NULL;'],
    ['ALTER TABLE chk RENAME COLUMN price TO cost;'],
  ])('%s', (script) => {
    expect(reasonOf(SOLE, script)).toContain('3959');
  });

  it('같은 문장에서 그 CHECK 를 지우면 받는다', () => {
    expect(checksOf(SOLE, 'ALTER TABLE chk DROP CHECK chk_chk_1, RENAME COLUMN qty TO amount;')).toEqual(['chk_price']);
  });

  it('이름을 안 바꾸는 MODIFY·쓰지 않는 컬럼의 이름 변경은 CHECK 를 그대로 둔다', () => {
    expect(checksOf(SOLE, 'ALTER TABLE chk MODIFY qty BIGINT NOT NULL;')).toEqual(['chk_chk_1', 'chk_price']);
    expect(checksOf(SOLE, 'ALTER TABLE chk RENAME COLUMN note TO memo;')).toEqual(['chk_chk_1', 'chk_price']);
  });
});

// SHOW CREATE 는 CHECK 를 이름(소문자) 코드 포인트 순으로 찍는다 (FK 와 같다). 테이블 이름을 바꾸면 자동 이름 '<테이블>_chk_N' 이 바뀌어 순서도 달라진다
describe('테이블 이름을 바꾸면 CHECK 를 이름 순으로 다시 놓는다', () => {
  it('RENAME TABLE·ALTER … RENAME TO', () => {
    expect(checksOf(SOLE, 'RENAME TABLE chk TO zzz;')).toEqual(['chk_price', 'zzz_chk_1']);
    expect(checksOf(SOLE, 'ALTER TABLE chk RENAME TO zzz, ADD COLUMN extra INT;')).toEqual(['chk_price', 'zzz_chk_1']);
    expect(checksOf(SOLE, 'RENAME TABLE chk TO aaa;')).toEqual(['aaa_chk_1', 'chk_price']);
  });

  it('이름이 안 바뀌는 CHECK 만 있으면 순서를 건드리지 않는다', () => {
    const onlyNamed = parseSqlDump(tdExport(tableSql('CONSTRAINT `b_second` CHECK ((`qty` >= 0))', 'CONSTRAINT `a_first` CHECK ((`price` > 0))'))).model;
    expect(checksOf(onlyNamed, 'RENAME TABLE chk TO zzz;')).toEqual(['b_second', 'a_first']);
  });

  it('sortChecks: 소문자 코드 포인트 순 (FK 정렬과 같은 규칙), 입력은 바꾸지 않는다', () => {
    const mk = (name: string): Check => ({ name, expr: '(1)', enforced: true });
    const input = ['Zeta', 'alpha', 'Beta', 'a_1', 'a1', 'a-b', 'ALPHA2', 't_chk_9', 't_chk_10', '한글'].map(mk);
    const before = JSON.stringify(input);
    expect(sortChecks(input).map((k) => k.name)).toEqual(['a-b', 'a1', 'a_1', 'alpha', 'ALPHA2', 'Beta', 't_chk_10', 't_chk_9', 'Zeta', '한글']);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('입력 모델은 바뀌지 않는다', () => {
  it('CHECK 가 사라지는 문장을 적용해도 기준 모델 JSON 이 그대로다', () => {
    const before = JSON.stringify(SOLE);
    const r = run(SOLE, 'ALTER TABLE chk DROP COLUMN qty;');
    expect(r.ok).toBe(true);
    expect(JSON.stringify(SOLE)).toBe(before);
    expect(SOLE.tables[0].checks.map((k) => k.name)).toEqual(['chk_chk_1', 'chk_price']);
  });
});
