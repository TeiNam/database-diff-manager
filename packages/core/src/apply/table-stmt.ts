// CREATE·DROP·RENAME TABLE
import { fkAutoNameCollides, renamedAutoName } from '../auto-name';
import type { Table } from '../model';
import { moveOrigins, nameTaken, needTable, type State } from './state';
import { fail } from './types';

// 테이블(또는 뷰) 이름 변경: 다른 테이블 FK 의 참조 테이블과 자동 제약명('<옛>_ibfk_N'·'<옛>_chk_N')이 따라 바뀐다 (MySQL 8.0)
export function renameTable(st: State, from: string, to: string): void {
  if (nameTaken(st, to)) fail(`이름 \`${to}\` 인 테이블·뷰가 이미 있습니다 (MySQL 1050)`);
  if (st.model.views.some((v) => v.name === from)) {
    st.model.views = st.model.views.map((v) => (v.name === from ? { ...v, name: to } : v));
    return;
  }
  const t = needTable(st, from);
  if (fkAutoNameCollides(t.foreignKeys, from, to)) fail(`이름을 바꾸면 자동 FK 이름이 다른 FK 와 겹칩니다: \`${from}\` → \`${to}\` (MySQL 1826)`);
  const renamed: Table = {
    ...t,
    name: to,
    foreignKeys: t.foreignKeys.map((f) => ({ ...f, name: renamedAutoName(f.name, from, to, 'ibfk') })),
    checks: t.checks.map((k) => ({ ...k, name: renamedAutoName(k.name, from, to, 'chk') })),
  };
  st.model.tables = st.model.tables
    .map((x) => (x.name === from ? renamed : x))
    .map((x) => ({ ...x, foreignKeys: x.foreignKeys.map((f) => (f.refTable === from && f.refSchema === undefined ? { ...f, refTable: to } : f)) }));
  moveOrigins(st.origins, from, to);
}
