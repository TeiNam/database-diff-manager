// 모델 → td-export 0.1.52 형식 SQL. 서버가 ALTER 적용 결과를 원문으로 저장한다 — parseSqlDump 로 다시 읽으면 같은 모델이 나와야 한다
import type { Routine, SchemaModel } from '../model';
import { printRoutine, printTable, printView } from '../print';
import { fail } from './types';

const HEADER = ['SET NAMES utf8mb4;', 'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;', "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';"];
const TRAILER = ['SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;', 'SET SQL_MODE = @OLD_SQL_MODE;'];
const DELIMITERS = [';;', '$$', '//'];
const UNSAFE_COMMENT = /\*\/|[\r\n]/;
// 구분자 후보: 본문에 없고, 본문 바로 뒤에 붙여도 맨 끝에서만 나타나야 한다. 본문이 ';' 로 끝나면 뒤에 붙인 ';;' 가 한 글자 앞에서 시작하는 것으로 읽혀 문장 끝이 앞당겨진다
const fitsAfter = (ddl: string, delimiter: string): boolean => `${ddl}${delimiter}`.indexOf(delimiter) === ddl.length;
// 객체 머리 주석. 이름에 주석을 닫는 문자가 있으면 주석을 쓰지 않는다 (파서는 주석을 보지 않는다)
const heading = (name: string): string[] => (UNSAFE_COMMENT.test(name) ? [] : [`/* Table : ${name} */`]);
// 문장 끝맺음(; 또는 구분자). 마지막 줄이 줄 주석(-- · #)으로 끝나면 바로 뒤에 붙인 끝맺음이 주석에 먹혀, 다시 읽을 때 뒤의 객체가 모두 이 문장에 딸려 간다.
// 마지막 줄에 주석 표지가 있으면 새 줄에 둔다 (문자열 안의 표지에서도 새 줄이 들어가지만 공백만 바뀐다 — 파서가 문장을 trim 한다)
const terminate = (text: string, end: string): string => (/--|#/.test(text.slice(text.lastIndexOf('\n') + 1)) ? `${text}\n${end}` : `${text}${end}`);

// 객체 순서는 모델 그대로 둔다. parseSqlDump 가 파일 순서를 지키므로 다시 읽으면 순서까지 같은 모델이 나온다
// (td-export 0.1.52 덤프의 뷰·루틴은 이름순이 아니라서, 이름순으로 다시 늘어놓으면 순서가 달라진다)
export function printSqlDump(model: SchemaModel): string {
  if (UNSAFE_COMMENT.test(model.name)) fail(`스키마 이름에 '*/'·줄바꿈이 있어 덤프 머리말을 쓸 수 없습니다: ${model.name}`);
  const out = [`/* Database : ${model.name} */`, ...HEADER, ''];
  if (model.routines.length) out.push('/* Routines */', ...model.routines.flatMap(routineBlock));
  for (const t of model.tables) out.push('', ...heading(t.name), terminate(printTable(t), ';'), '');
  for (const v of model.views) out.push('', ...heading(v.name), terminate(printView(v), ';'), '');
  return [...out, '', ...TRAILER, ''].join('\n');
}

// td-export 0.1.52 의 루틴 블록: SQL_MODE 저장·설정 → DELIMITER → CREATE → 복원
function routineBlock(r: Routine): string[] {
  const ddl = printRoutine(r);
  const delimiter = DELIMITERS.find((d) => fitsAfter(ddl, d)) ?? fail(`루틴 \`${r.name}\` 본문에 구분자로 쓸 수 있는 문자열이 없습니다`);
  const mode = r.sqlMode === undefined ? [] : [`SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = '${r.sqlMode}';`];
  return [...mode, `DELIMITER ${delimiter}`, terminate(ddl, delimiter), 'DELIMITER ;', ...(mode.length ? ['SET SQL_MODE = @OLD_ROUTINE_SQL_MODE;'] : [])];
}
