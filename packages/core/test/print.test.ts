import { describe, expect, it } from 'vitest';
import { normalizeDdl } from '../src/normalize';
import { parseSqlDump } from '../src/parse-dump';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';
import { printColumn, printTable, printView } from '../src/print';
import { fixture, sample } from './helpers';

describe('normalizeDdl', () => {
  it('AUTO_INCREMENT=N, 정수 표시 폭, 줄 끝 공백, 끝 세미콜론을 제거한다', () => {
    const ddl = 'CREATE TABLE `t` (\n  `a` int(11) NOT NULL,\n  `b` tinyint(1) NOT NULL,\n  `c` int(10) unsigned zerofill \n) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4;';
    expect(normalizeDdl(ddl)).toBe(
      'CREATE TABLE `t` (\n  `a` int NOT NULL,\n  `b` tinyint(1) NOT NULL,\n  `c` int(10) unsigned zerofill\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
  });

  it('뷰 DEFINER를 제거한다', () => {
    expect(normalizeDdl('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1')).toBe(
      'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1',
    );
  });
});

describe('print 왕복', () => {
  it('테이블: print(parse(x)) === normalize(x)', () => {
    const ddl = fixture('parse-table.sql');
    expect(printTable(parseCreateTable(ddl))).toBe(normalizeDdl(ddl));
  });

  it('뷰: print(parse(x)) === normalize(x)', () => {
    const ddl = fixture('view.sql');
    expect(printView(parseCreateView(ddl))).toBe(normalizeDdl(ddl));
  });

  it('실데이터 33개 테이블 모두 왕복이 일치한다', () => {
    const { warnings } = parseSqlDump(sample('sql'));
    expect(warnings).toEqual([]);
  });

  it('왕복 불일치는 경고와 rawDdl로 남긴다', () => {
    // TABLESPACE 는 '=' 없이 출력되어 재출력 형식이 다르다
    const { model, warnings } = parseSqlDump('CREATE TABLE `t` (\n  `a` int\n) TABLESPACE `ts`;');
    expect(warnings.map((w) => w.object)).toEqual(['t']);
    expect(model.tables[0].rawDdl).toBe('CREATE TABLE `t` (\n  `a` int\n) TABLESPACE `ts`');
  });
});

describe('printColumn', () => {
  it('ALTER용(versioned=false)은 버전 주석을 쓰지 않는다', () => {
    const col = { name: 'a', type: 'int', nullable: false, invisible: true, autoIncrement: false };
    expect(printColumn(col)).toBe('`a` int NOT NULL /*!80023 INVISIBLE */');
    expect(printColumn(col, false)).toBe('`a` int NOT NULL INVISIBLE');
  });

  it('nullable timestamp는 NULL을 명시한다', () => {
    expect(printColumn({ name: 't', type: 'timestamp', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' })).toBe(
      '`t` timestamp NULL DEFAULT NULL',
    );
  });
});
