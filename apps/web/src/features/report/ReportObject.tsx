import { Icon } from '../../components/Icon';
import { Mark } from '../../components/Mark';
import { buildRows, countChanges } from '../../lib/hunks';
import { objectAnchor, type ObjectEntry } from '../../lib/object-diff';
import { ObjectBody } from '../diff/ObjectBody';
import card from '../diff/ObjectCard.module.css';

// 리포트의 객체 하나: JS 없이 접고 펼 수 있게 <details open> 으로 감싸고, 동일 구간은 모두 펼친다 (설계 §3.4)
export function ReportObject({ entry, mode, layout }: { entry: ObjectEntry; mode: 'sql' | 'grid'; layout: 'split' | 'unified' }) {
  const rows = buildRows(entry.baseText, entry.targetText);
  const counts = countChanges(rows);
  const name = entry.oldName && entry.op === 'rename' ? `${entry.oldName} → ${entry.name}` : entry.name;
  return (
    <details open className={`${card.card} report-object`} id={objectAnchor(entry.kind, entry.name)} aria-label={`${entry.kind} ${entry.name}`}>
      <summary className={card.head}>
        <Mark op={entry.op} />
        <Icon name={entry.kind} />
        <span className="report-kind">{entry.kind}</span>
        <span className={`${card.path} ${entry.op === 'drop' ? 'struck' : ''}`}>{name}</span>
        <span className={card.numAdd}>+{counts.added}</span>
        <span className={card.numDel}>−{counts.removed}</span>
      </summary>
      <ObjectBody entry={entry} mode={mode} layout={layout} rows={rows} expanded />
    </details>
  );
}
