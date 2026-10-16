import type { DiffResponse } from '../../api/types';
import type { ObjectKind } from '../../hooks/useSchemaContext';
import { SummaryView } from './SummaryView';

// 화면 요약 탭: 변경 객체 항목을 누르면 객체 diff 탭의 그 객체로 간다
export function SummaryTab({ data, onOpen }: { data: DiffResponse; onOpen: (kind: ObjectKind, name: string) => void }) {
  return (
    <SummaryView
      data={data}
      renderItem={({ entry, className, children }) => (
        <button type="button" className={className} onClick={() => onOpen(entry.kind, entry.name)}>{children}</button>
      )}
    />
  );
}
