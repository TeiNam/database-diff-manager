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
