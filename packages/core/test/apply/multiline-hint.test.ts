import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 여러 줄에 걸친 힌트 (리뷰 15회차 F4, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): mysql 클라이언트는 '/*+' 를 연 줄에서만 그 안을 힌트로 보고(add_line 의 ss_comment 는 줄마다 새로
// 시작한다) 다음 줄부터는 힌트 밖의 글로 읽는다 — 지금 구분자에서 문장을 끊고, 따옴표에서 문자열을 열고, '#'·'-- '·'/*' 를 주석으로, '\' 를 클라이언트 명령으로 읽는다. 서버와
// 렉서는 첫 '*/' 까지를 한 주석으로 읽어, 둘째 줄부터 그것이 있으면 MySQL 은 1064 로 멈추거나 판에 따라 다른 글을 실행하는데 14회차까지는 뒤 DDL 까지 적용했다
const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;')).model;
const run = (script: string): ApplyResult => applyScript(base, script, { schemaName: 'shop' });
const outcome = (r: ApplyResult): string => (r.ok ? `${r.model.tables[0].columns.map((c) => c.name)} / ${r.model.routines.map((x) => x.name)}` : r.error.reason);
const ROUTINE = (hint: string, delimiter = ';;') => `ALTER TABLE t ADD a INT;\nDELIMITER ${delimiter}\nCREATE PROCEDURE p() BEGIN SELECT ${hint} 1; END${delimiter}\nDELIMITER ;\nALTER TABLE t ADD b INT;\n`;

describe('둘째 줄부터 mysql 클라이언트가 달리 읽는 글이 든 여러 줄 힌트', () => {
  // [이름, 스크립트, 거부하는 문장 번호, 문장 앞 덩어리의 것이면 그 줄 (문장 안의 것은 앞말이 없다)] — 실측 결과는 이름 뒤에 적는다
  it.each([
    ['구분자 (Claude 재현 m4 — 두 클라이언트 모두 1064 로 a 만)', 'ALTER TABLE t ADD a INT;\n/*+ 메모: 이 컬럼은\n   VIP 등급입니다; 삭제 금지 */\nALTER TABLE t ADD b INT;\n', 2, 2],
    ['문장 안의 구분자 (m1 — 모두 1064)', 'ALTER TABLE t ADD a INT /*+ step 1\n  then step 2; done */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 1, 0],
    ['상자 꼴 주석의 구분자 (m2 — 모두 1064)', '/*+------------------------------+\n | v2: 등급 추가; 포인트 추가 |\n +------------------------------+*/\nALTER TABLE t ADD a INT;\n', 1, 1],
    ['셋째 줄의 구분자 (모두 1064)', 'ALTER TABLE t ADD a INT /*+ x\n y\n z; */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 1, 0],
    ['문장 없는 덩어리의 구분자 (모두 1064 로 a 만)', 'ALTER TABLE t ADD a INT;\n/*+ a\n b; */;\nALTER TABLE t ADD c INT;\n', 2, 2],
    ['그때 바꾼 구분자 $$ 로 끝낸 문장 없는 덩어리 (모두 1064 로 a 만)', 'ALTER TABLE t ADD a INT;\nDELIMITER $$\n/*+ a\n b$$ */$$\nDELIMITER ;\nALTER TABLE t ADD c INT;\n', 2, 3],
    ['바꾼 구분자 ;; (모두 1064 로 a 만)', ROUTINE('/*+ x\n ;; */'), 2, 0],
    ['바꾼 구분자 $$ (모두 1064 로 a 만)', ROUTINE('/*+ x\n $$ */', '$$'), 2, 0],
    ['홑따옴표가 뒤 DELIMITER 줄까지 묶는다 (m6 — 모두 a·b 뒤 1064)', 'ALTER TABLE t ADD a INT;\nALTER TABLE t ADD b INT /*+ note\n don\'t */;\nDELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD c INT;\n', 2, 0],
    ['큰따옴표 (뒤 문장을 문자열로 묶는다 — 보수적)', 'ALTER TABLE t ADD a INT /*+ x\n " */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 1, 0],
    ['백틱 (뒤 문장을 이름으로 묶는다 — 보수적)', 'ALTER TABLE t ADD a INT /*+ x\n ` */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 1, 0],
    ['# 줄 주석 (8.0 은 1064 로 a 만, 8.4 는 a·b — m3 의 -- 도 같다)', 'ALTER TABLE t ADD a INT;\n/*+ note\n# end */\nALTER TABLE t ADD b INT;\n', 2, 2],
    ['-- 줄 주석 (8.0 은 1064, 8.4 는 a·b·c)', 'ALTER TABLE t ADD a INT /*+ x\n-- y */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 1, 0],
    ['주석 (8.0 은 1064, 8.4 는 a·b·c)', 'ALTER TABLE t ADD a INT /*+ x\n /* y */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 1, 0],
    ['클라이언트 명령 \\g (모두 1064)', 'ALTER TABLE t ADD a INT /*+ x\n \\g */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 1, 0],
    ['클라이언트 명령 \\c (모두 1064)', 'ALTER TABLE t ADD a INT /*+ x\n \\c */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 1, 0],
  ])('RE_EXPORT 로 거부한다 — %s', (_name, script, index, line) => {
    const r = run(script);
    expect(r).toMatchObject({ ok: false, error: { index } });
    if (r.ok) return;
    expect(r.error.reason).toContain('여러 줄에 걸친 힌트 /*+');
    expect(r.error.reason.startsWith(line ? `앞 문장 뒤(줄 ${line})의 ` : '여러 줄'), r.error.reason).toBe(true);
    expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  // 두 클라이언트 모두 렉서와 같다 (실측)
  it.each([
    ['둘째 줄에 아무것도 없는 것', 'ALTER TABLE t ADD a INT /*+ x\n y */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 'id,a,b,c / '],
    ['첫 줄의 구분자 (그 줄에서는 힌트다)', 'ALTER TABLE t ADD a INT /*+ x; y\n z */, ADD b INT;\nALTER TABLE t ADD c INT;\n', 'id,a,b,c / '],
    ['힌트를 닫은 뒤의 따옴표', "ALTER TABLE t ADD a INT /*+ x\n y */ COMMENT 'q', ADD b INT;\nALTER TABLE t ADD c INT;\n", 'id,a,b,c / '],
    ['루틴 본문의 여러 줄 옵티마이저 힌트', ROUTINE('/*+ BKA(t)\n NO_ICP(t) */'), 'id,a,b / p'],
    ["구분자가 ;; 일 때의 ';'", ROUTINE('/*+ x\n ; */'), 'id,a,b / p'],
    ["구분자가 $$ 일 때의 ';'", ROUTINE('/*+ x\n ; */', '$$'), 'id,a,b / p'],
    ["여러 줄 일반 주석의 ';' (Claude 대조군 m5)", '/* 일반 주석: 이 컬럼은\n   VIP 등급입니다; 삭제 금지 */\nALTER TABLE t ADD a INT;\n', 'id,a / '],
  ])('받는다 — %s', (_name, script, expected) => {
    expect(outcome(run(script))).toBe(expected);
  });
});
