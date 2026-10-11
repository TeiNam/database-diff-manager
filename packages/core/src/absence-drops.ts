// 부재 기반 파괴 문장 (15회차 원칙, 17회차 3 일반화): TARGET 에 없다는 이유로 나오는 삭제. TARGET 이 완전한 덤프라는 양성 증거가
// 없으면(ddl-guard) 이 목록의 객체 문장을 실행하지 않는다. 한 곳에서 모두 열거한다 — 객체(테이블·뷰·함수·프로시저), 컬럼,
// 행이 지워지는 파티션 변경(파티션 삭제·LIST 값 제거·재정의), 인덱스·PRIMARY KEY·FK·CHECK 삭제.
// 교체(정의가 바뀌어 DROP→ADD 하는 인덱스·FK·CHECK·PK, op 'modify')는 TARGET 에 있는 정의로 다시 만들므로 부재 기반이 아니다
import type { SchemaDiff, TableDiff } from './diff';
import type { RoutineKind } from './model';
import { partitionDropsRows } from './partition-ddl';

export type AbsenceKind = 'table' | 'view' | RoutineKind | 'column' | 'partition' | 'index' | 'primary-key' | 'foreign-key' | 'check';

export interface AbsenceDrop {
  kind: AbsenceKind;
  object: string; // 테이블·뷰·루틴 이름 (TARGET 이름, 삭제되는 객체는 BASE 이름)
  name?: string; // 테이블 안의 컬럼·인덱스·FK·CHECK 이름 (PRIMARY KEY 는 'PRIMARY')
}

// 바뀌는(modify·rename) 테이블 안의 부재 기반 삭제
function tableParts(d: TableDiff): AbsenceDrop[] {
  const part = (kind: AbsenceKind, name: string): AbsenceDrop => ({ kind, object: d.name, name });
  return [
    ...d.columns.filter((c) => c.op === 'drop').map((c) => part('column', c.name)),
    ...(partitionDropsRows(d) ? [{ kind: 'partition' as const, object: d.name }] : []),
    ...d.indexes.filter((i) => i.op === 'drop').map((i) => part(i.from?.kind === 'PRIMARY' ? 'primary-key' : 'index', i.name)),
    ...d.foreignKeys.filter((f) => f.op === 'drop').map((f) => part('foreign-key', f.name)),
    ...d.checks.filter((c) => c.op === 'drop').map((c) => part('check', c.name)),
  ];
}

export function absenceDrops(diff: Pick<SchemaDiff, 'tables' | 'views' | 'routines'>): AbsenceDrop[] {
  return [
    ...diff.tables.flatMap((d): AbsenceDrop[] => (d.op === 'drop' ? [{ kind: 'table', object: d.name }]
      : d.op === 'modify' || d.op === 'rename' ? tableParts(d) : [])),
    ...diff.views.filter((v) => v.op === 'drop').map((v): AbsenceDrop => ({ kind: 'view', object: v.name })),
    ...diff.routines.filter((r) => r.op === 'drop').map((r): AbsenceDrop => ({ kind: r.kind, object: r.name })),
  ];
}
