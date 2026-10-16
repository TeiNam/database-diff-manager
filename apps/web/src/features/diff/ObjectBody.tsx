import type { SplitRow } from '../../lib/hunks';
import { isRoutineKind, type ObjectEntry } from '../../lib/object-diff';
import { GridDiff } from './GridDiff';
import { RoutineGrid } from './RoutineGrid';
import { SqlDiff } from './SqlDiff';

// 객체 본문: 표 보기면 테이블은 표, 루틴은 루틴 표, 그 밖(뷰·SQL 보기)은 SQL diff. 화면 카드와 HTML 리포트가 함께 쓴다
// rows: 카드가 이미 계산한 줄 (없으면 SqlDiff 가 계산한다). expanded: 동일 구간을 접지 않는다
export function ObjectBody({ entry, mode, layout, rows, expanded }: {
  entry: ObjectEntry; mode: 'sql' | 'grid'; layout: 'split' | 'unified'; rows?: SplitRow[]; expanded: boolean;
}) {
  if (mode === 'grid' && entry.kind === 'table') return <GridDiff entry={entry} />;
  if (mode === 'grid' && isRoutineKind(entry.kind)) return <RoutineGrid entry={entry} />;
  return <SqlDiff rows={rows} base={entry.baseText} target={entry.targetText} layout={entry.op === 'same' ? 'unified' : layout} expanded={expanded} />;
}
