import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// DELIMITER 줄 앞의 mysql 클라이언트 버퍼 (리뷰 15회차 F1·F2, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측). 클라이언트는 DELIMITER 줄을 버퍼가 빌 때만 명령으로 읽는다:
// 8.0 은 일반 블록 주석·줄 주석을 지우고 실행 주석('/*!')·힌트('/*+')만 버퍼에 남긴다. 8.4 는 주석을 남기되 버퍼가 공백과 블록 주석뿐이면 버리고 명령으로 읽는데, 블록 주석
// 안에 '*'·'/' 가 있거나 버퍼에 줄 주석이 있으면 읽지 않는다 — 버퍼가 비었을 때의 줄 주석만 따로 보내고 공백·블록 주석 뒤의 것은 버퍼에 남긴다. 명령으로 읽지 않으면 DELIMITER
// 줄을 문장으로 보내 1064 다. 판에 따라 갈리면 RE_EXPORT 로 거부한다 (14회차까지는 이 앞의 문장 없는 덩어리 하나만 실행 주석·힌트를 보았다)
const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;')).model;
const run = (script: string): ApplyResult => applyScript(base, script, { schemaName: 'shop' });
const PRE = 'ALTER TABLE t ADD a INT;\n';
const POST = 'DELIMITER ;;\nCREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT;\n';
const outcome = (r: ApplyResult): string => (r.ok ? `${r.model.tables[0].columns.map((c) => c.name)} / ${r.model.routines.map((x) => x.name)}` : r.error.reason);
const expectReExport = (r: ApplyResult, index: number, line: number, ...parts: string[]): void => {
  expect(r).toMatchObject({ ok: false, error: { index } });
  if (r.ok) return;
  for (const part of parts) expect(r.error.reason).toContain(part);
  expect(r.error.reason).toContain('DELIMITER 줄');
  expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  expect(r.error.reason).toContain(`앞 문장 뒤(줄 ${line})의 `);
};

describe('DELIMITER 줄 앞의 실행 주석·힌트 — 8.0 클라이언트만 버퍼에 남긴다 (F1)', () => {
  // 8.0 클라이언트는 1064 로 a 만, 8.4 클라이언트는 a·b 와 루틴 p (실측). DELIMITER 줄 뒤에 문장 없는 덩어리가 오면 그 덩어리를 끝낸 구분자까지를 한 덩어리로 보아 검사가 빠졌다
  it.each([
    ['뒤에 문장 없는 덩어리 (Claude 재현 h1)', '/*!40101 */\nDELIMITER ;;\n;;\n'],
    ['힌트 (h2)', '/*+ x */\nDELIMITER ;;\n;;\n'],
    ['건너뛰는 주석 뒤 건너뛰는 주석만 든 덩어리 (h3)', '/*!99999 */\nDELIMITER ;;\n/*!99999 */;;\n'],
    ['줄 주석과 구분자만 든 덩어리 (h4)', '/*!40101 */\nDELIMITER ;;\n-- x\n;;\n'],
    ['두 DELIMITER 줄 사이의 덩어리 (h5)', '/*!40101 */\nDELIMITER $$\n$$\nDELIMITER ;;\n'],
    ['닫는 */ 를 DELIMITER 줄에 둔 것', '/*!99999 \nDELIMITER ;; */\n;;\n'],
  ])('RE_EXPORT 로 거부하고 표지의 줄을 밝힌다 — %s', (_name, middle) => {
    const r = run(`${PRE}${middle}CREATE PROCEDURE p() SELECT 1;;\nDELIMITER ;\nALTER TABLE t ADD b INT;\n`);
    expectReExport(r, 2, 2, middle.startsWith('/*+') ? '힌트 /*+' : '실행 주석 /*!');
  });
});

describe('DELIMITER 줄 앞의 블록 주석·줄 주석 — 8.4 클라이언트만 버퍼에 남긴다 (F2)', () => {
  // 8.0 클라이언트는 a·b 와 루틴 p, 8.4 클라이언트는 1064 로 a 만 (실측). 14회차는 8.4 가 공백·블록 주석을 모두 버린다고 보아 받았다
  it.each([
    ['블록 주석 뒤 줄 주석 (Claude 재현)', '/* 프로시저 추가 */\n-- 작성자: 홍길동\n', 3, '줄 주석'],
    ['안에 / 가 든 블록 주석 (날짜)', '/* 2024/01/15 프로시저 추가 */\n', 2, "'*'·'/' 가 든 블록 주석"],
    ['javadoc 꼴 블록 주석', '/**\n * 등급 프로시저\n */\n', 2, "'*'·'/' 가 든 블록 주석"],
    ['안에 * 가 든 블록 주석', '/* a*b */\n', 2, "'*'·'/' 가 든 블록 주석"],
    ['** 로 닫은 블록 주석', '/* x **/\n', 2, "'*'·'/' 가 든 블록 주석"],
    ['닫는 */ 와 겹친 /*/ (8.0 클라이언트는 닫지 않고 뒤를 모두 주석으로 본다)', '/* x/*/\n', 2, "'*'·'/' 가 든 블록 주석"],
    ['첫 글자가 / 인 블록 주석 (두 클라이언트 모두 받는다 — 보수적)', '/*/ x */\n', 2, "'*'·'/' 가 든 블록 주석"],
    ['공백만 있는 줄 뒤 줄 주석', '   \n-- y\n', 3, '줄 주석'],
    ['들여 쓴 줄 주석', '  -- y\n', 2, '줄 주석'],
    ['탭으로 들여 쓴 줄 주석', '\t-- y\n', 2, '줄 주석'],
    ['같은 줄의 블록 주석 뒤 줄 주석', '/* a */ -- y\n', 2, '줄 주석'],
    ['블록 주석 다음 줄의 # 줄 주석', '/* x */\n# y\n', 3, '줄 주석'],
  ])('RE_EXPORT 로 거부하고 그 줄을 밝힌다 — %s', (_name, before, line, part) => {
    expectReExport(run(`${PRE}${before}${POST}`), 2, line, part);
  });

  it.each([
    ['앞 구분자 뒤 같은 줄의 * 가 든 블록 주석', 'ALTER TABLE t ADD a INT; /* a*b */\n', 2, 1, "'*'·'/' 가 든 블록 주석"],
    ['앞 구분자 뒤 같은 줄의 블록 주석 뒤 줄 주석', 'ALTER TABLE t ADD a INT; /* x */ -- y\n', 2, 1, '줄 주석'],
    ['스크립트 맨 앞의 들여 쓴 줄 주석', '  -- y\n', 1, 1, '줄 주석'],
  ])('앞 구분자와 같은 줄·스크립트 맨 앞도 같다 — %s', (_name, head, index, line, part) => {
    expectReExport(run(`${head}${POST}`), index, line, part);
  });
});

describe('두 클라이언트가 모두 명령으로 읽는 DELIMITER 줄', () => {
  // 넷 모두 a·b 와 루틴 p (실측): 8.4 는 버퍼가 비었을 때의 줄 주석을 따로 보내고, 앞 구분자와 같은 줄의 공백·줄 주석은 앞 문장과 함께 보내며, 주석만 버퍼에 있던 DELIMITER 줄을
  // 읽은 뒤에는 버퍼를 비운다
  it.each([
    ['블록 주석 하나 (Claude 대조군)', '/* 프로시저 추가 */\n'],
    ['빈 블록 주석', '/**/\n'],
    ['한 줄에 블록 주석 둘', '/* a */ /* b */\n'],
    ['두 줄의 블록 주석', '/* a */\n/* b */\n'],
    ['여러 줄 블록 주석', '/* a\n b */\n'],
    ['줄 주석 뒤 블록 주석', '-- y\n/* x */\n'],
    ['# 줄 주석', '# y\n'],
    ['줄 주석 뒤 공백만 있는 줄', '-- y\n   \n'],
    ['빈 줄 뒤 줄 주석', '\n-- y\n'],
    ['공백만 있는 줄 뒤 블록 주석', '   \n/* x */\n'],
    ['블록 주석 뒤 공백', '/* x */   \n'],
    ['탭만 있는 줄', '\t\n'],
    ["';' 로 끝낸 블록 주석 뒤 줄 주석", '/* x */;\n-- y\n'],
    ["';' 로 끝낸 * 가 든 블록 주석", '/** x */;\n'],
  ])('받는다 — %s', (_name, before) => {
    expect(outcome(run(`${PRE}${before}${POST}`))).toBe('id,a,b / p');
  });

  it.each([
    ['앞 구분자 뒤 같은 줄의 줄 주석', 'ALTER TABLE t ADD a INT;  -- y\n'],
    ['앞 구분자 뒤 같은 줄의 블록 주석', 'ALTER TABLE t ADD a INT; /* x */\n'],
    ['주석만 버퍼에 있던 DELIMITER 줄 뒤의 줄 주석', 'ALTER TABLE t ADD a INT;\n/* x */\nDELIMITER $$\n-- y\n'],
  ])('받는다 — %s', (_name, head) => {
    expect(outcome(run(`${head}${POST}`))).toBe('id,a,b / p');
  });
});

// DELIMITER 의 인자 (리뷰 15회차 후속, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 클라이언트는 첫 낱말(공백·탭 앞까지)이 DELIMITER 인 줄만 명령으로 읽고('\g' 가 든 줄은 빼고),
// 그 줄의 앞 255바이트에서 인자를 읽어(com_delimiter·get_arg) 따옴표 밖의 백슬래시를 지우고 남은 백슬래시와 빈 인자는 오류로 거부해 구분자를 바꾸지 않으며, 구분자는 앞 15바이트만
// 쓴다(delimiter[16]). 문장 나누기와 다르게 읽으면 RE_EXPORT 로 거부한다 — 14회차까지는 긴 구분자·백슬래시를 그대로, 'DELIMITER;;'·'DELIMITER\v;;' 를 명령으로 읽었다
describe('mysql 클라이언트가 다르게 읽는 DELIMITER 인자', () => {
  const D16 = '$'.repeat(16);
  const D15 = '$'.repeat(15);
  const tail = (end: string) => `ALTER TABLE t ADD b INT${end}\nDELIMITER ;\nALTER TABLE t ADD c INT;\n`;
  const ROUTINE = 'CREATE PROCEDURE p() BEGIN SELECT 1; END;;\nDELIMITER ;\nALTER TABLE t ADD b INT;\n';
  // [이름, DELIMITER 줄과 그 뒤, 안내의 줄, 안내에 든 말] — 실측 결과는 이름에 적는다
  it.each([
    ['16바이트 구분자 (클라이언트는 앞 15바이트를 써 a·b·c)', `DELIMITER ${D16}\n${tail(D15)}`, 2, '15바이트'],
    ['16바이트 구분자로 끝낸 문장 (클라이언트는 a·b 뒤 1064)', `DELIMITER ${D16}\n${tail(D16)}`, 2, '15바이트'],
    ['18바이트 한글 구분자 (a·b·c)', `DELIMITER 한글한글한글\n${tail('한글한글한')}`, 2, '15바이트'],
    ['글자 가운데서 15바이트가 끝나는 구분자 (a·b 뒤 1064)', `DELIMITER $한글한글한\n${tail('$한글한글한')}`, 2, '15바이트'],
    ['DELIMITER 에 붙은 구분자 (오류 뒤 1064)', `DELIMITER;;\n${ROUTINE}`, 2, '공백'],
    ["DELIMITER 에 붙은 ';;' 뒤의 인자 (오류 뒤 1064)", `DELIMITER;; $$\n${tail('$$')}`, 2, '공백'],
    ['세로 탭으로 띄운 구분자 (1064)', `DELIMITER\v;;\n${ROUTINE}`, 2, '공백'],
    ['따옴표 밖의 백슬래시 (클라이언트는 지우고 $$ — a·b·c)', `DELIMITER $\\$\n${tail('$$')}`, 2, '백슬래시'],
    ['따옴표 안의 백슬래시 (오류로 바꾸지 않는다 — a 뒤 중단)', `DELIMITER '$\\$'\n${tail('$\\$')}`, 2, '백슬래시'],
    ['줄 처음부터 255바이트를 넘는 구분자 (클라이언트는 $$ — a·b·c)', `DELIMITER${' '.repeat(244)}$$$$\n${tail('$$')}`, 2, '255바이트'],
    ["'\\g' 가 든 DELIMITER 줄 (문장으로 보내 1064)", `DELIMITER ;; -- \\g\n${ROUTINE}`, 2, "'\\g'"],
    ["ASCII 밖 글자가 든 낱말 'delımiter' (렉서는 DELIMITER 로 읽는다 — 1064)", `del\u0131miter ;;\n${ROUTINE}`, 2, '첫 낱말'],
  ])('RE_EXPORT 로 거부한다 — %s', (_name, rest, line, part) => {
    const r = run(`${PRE}${rest}`);
    expect(r).toMatchObject({ ok: false, error: { index: 2 } });
    if (r.ok) return;
    expect(r.error.reason.startsWith(`앞 문장 뒤(줄 ${line})의 DELIMITER 줄`), r.error.reason).toBe(true);
    expect(r.error.reason).toContain(part);
    expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  it('바꾼 구분자 뒤의 빈 DELIMITER 줄은 거부한다 (클라이언트는 오류를 내고 ;; 를 그대로 써 a·b·p)', () => {
    const r = run(`${PRE}DELIMITER ;;\nDELIMITER\n${ROUTINE}`);
    expect(r).toMatchObject({ ok: false, error: { index: 2 } });
    expect(!r.ok && r.error.reason).toContain('앞 문장 뒤(줄 3)의 DELIMITER 줄');
    expect(!r.ok && r.error.reason).toContain('구분자가 없');
  });

  // 두 클라이언트 모두 문장 나누기와 같게 읽는다 (실측)
  it.each([
    ['15바이트 구분자', `DELIMITER ${D15}\n${tail(D15)}`, 'id,a,b,c / '],
    ['15바이트 한글 구분자', `DELIMITER 한글한글한\n${tail('한글한글한')}`, 'id,a,b,c / '],
    ['255바이트에서 끝나는 구분자', `DELIMITER${' '.repeat(244)}$$\n${tail('$$')}`, 'id,a,b,c / '],
    ['255바이트를 넘는 줄 주석 꼬리', `DELIMITER $$ -- ${'x'.repeat(300)}\n${tail('$$')}`, 'id,a,b,c / '],
    ['탭으로 띄운 구분자', `DELIMITER\t;;\n${tail(';;')}`, 'id,a,b,c / '],
    ['닫지 않은 따옴표', `DELIMITER '$$\n${tail('$$')}`, 'id,a,b,c / '],
    ['소문자 delimiter', `delimiter ;;\n${ROUTINE.replace('DELIMITER ;', 'delimiter ;')}`, 'id,a,b / p'],
    ["'\\G' 가 든 DELIMITER 줄", `DELIMITER ;; -- \\G\n${ROUTINE}`, 'id,a,b / p'],
    ['들여 쓴 DELIMITER 줄', `   DELIMITER ;;\n${ROUTINE.replace('DELIMITER ;', '\tDELIMITER ;')}`, 'id,a,b / p'],
    ["따옴표로 감싼 ';;'", `DELIMITER ';;'\n${ROUTINE}`, 'id,a,b / p'],
    ["구분자가 ';' 일 때의 빈 DELIMITER 줄 (클라이언트는 오류를 내고 ';' 를 그대로 쓴다)", 'DELIMITER\nALTER TABLE t ADD b INT;\n', 'id,a,b / '],
  ])('받는다 — %s', (_name, rest, expected) => {
    expect(outcome(run(`${PRE}${rest}`))).toBe(expected);
  });
});
