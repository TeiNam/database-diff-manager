import type { Routine } from '@tdm/core';
import type { ObjectEntry } from '../../lib/object-diff';
import s from './GridDiff.module.css';

// 표 보기 행: 항목 이름과 값을 꺼내는 함수, diff 필드 이름 (바뀐 행 표시용)
const ROWS: { label: string; field: string; value: (r: Routine) => string }[] = [
  { label: '파라미터', field: 'params', value: (r) => r.params },
  { label: 'RETURNS', field: 'returns', value: (r) => r.returns ?? '' },
  { label: 'DETERMINISTIC', field: 'characteristics.deterministic', value: (r) => (r.characteristics.deterministic ? 'YES' : 'NO') },
  { label: 'SQL 데이터 접근', field: 'characteristics.dataAccess', value: (r) => r.characteristics.dataAccess ?? 'CONTAINS SQL' },
  { label: 'SQL SECURITY', field: 'characteristics.security', value: (r) => r.characteristics.security ?? 'DEFINER' },
  { label: 'COMMENT', field: 'characteristics.comment', value: (r) => r.characteristics.comment ?? '' },
  { label: 'SQL_MODE', field: 'sqlMode', value: (r) => r.sqlMode ?? '' },
  { label: '본문', field: 'body', value: (r) => r.body },
];

const asRoutine = (o: ObjectEntry['from']) => (o && o.kind !== 'table' && o.kind !== 'view' ? o : undefined);

// 루틴 표 보기: 항목 | BASE | TARGET. 본문 전체 비교는 SQL 보기에서 한다
export function RoutineGrid({ entry }: { entry: ObjectEntry }) {
  const from = asRoutine(entry.from);
  const to = asRoutine(entry.to);
  const changed = new Set(entry.routine?.fields ?? []);
  // 함수가 아니면 RETURNS 행은 뺀다
  const rows = ROWS.filter((row) => row.field !== 'returns' || entry.kind === 'function');
  return (
    <div className={s.wrap}>
      <div className={s.scroll}>
        <table className={s.grid} aria-label="루틴 정의">
          <thead>
            <tr><th scope="col">항목</th><th scope="col">BASE</th><th scope="col">TARGET</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const a = from ? row.value(from) : undefined;
              const b = to ? row.value(to) : undefined;
              const isMod = from !== undefined && to !== undefined && (changed.has(row.field) || a !== b);
              return (
                <tr key={row.field} className={isMod ? s.mod : undefined}>
                  <th scope="row">{row.label}</th>
                  <td className={`${a === undefined ? s.pad : ''} ${s.wrapText} ${isMod ? 'cellDel' : ''}`.trim() || undefined}>{a}</td>
                  <td className={`${b === undefined ? s.pad : ''} ${s.wrapText} ${isMod ? 'cellAdd' : ''}`.trim() || undefined}>{b}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
