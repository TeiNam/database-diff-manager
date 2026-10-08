import type { Statement } from '@tdm/core';
import { renderDdl } from '@tdm/core';
import { useEffect, useRef, useState } from 'react';
import type { DiffResponse } from '../../api/types';
import { Icon } from '../../components/Icon';
import { useSchemaContext } from '../../hooks/useSchemaContext';
import { copyText } from '../../lib/clipboard';
import { downloadText } from '../../lib/download';
import { handleRadioKeys } from '../../lib/radio-group';
import s from './DdlTab.module.css';

const COPY_FEEDBACK_MS = 2000;
const MARK = { add: '+', drop: '-', modify: '~', rename: '>' } as const;

function CopyButton({ text, label = '복사', disabled = false }: { text: string; label?: string; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 언마운트 시 라벨 복귀 타이머 정리
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (next: 'done' | 'fail') => {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPY_FEEDBACK_MS);
  };
  const message = state === 'done' ? '복사됨' : state === 'fail' ? '복사 실패' : '';
  return (
    <>
      <button type="button" className={s.btn} aria-label={label} disabled={disabled} onClick={() => copyText(text).then(() => show('done'), () => show('fail'))}>
        <Icon name="copy" />{message || label}
      </button>
      {/* 스크린리더용 복사 결과 안내 (버튼 이름은 그대로 둔다) */}
      <span role="status" className="visually-hidden">{message}</span>
    </>
  );
}

// 파일명에 쓸 수 없는 문자를 '_'로 바꾼다
const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|\s]/g, '_');

function StatementBlock({ st }: { st: Statement }) {
  const header = `${MARK[st.op]} ${st.kind.toUpperCase()} ${st.object}`;
  return (
    <section className={s.block} aria-label={header}>
      <div className={s.blockHead}>
        <code>-- [{MARK[st.op]}] {st.kind.toUpperCase()} {st.object}</code>
        <CopyButton text={renderDdl([st])} />
      </div>
      <pre className={s.sql}>
        {st.notes?.map((n, i) => <span key={`${i}-${n}`} className={s.note}>{`-- ${n}`}{'\n'}</span>)}
        {st.comment ? st.sql : `${st.sql};`}
      </pre>
    </section>
  );
}

const DIRECTIONS = ['forward', 'backward'] as const;

// 앱은 DDL을 실행하지 않는다. 보여 주고 복사·다운로드만 한다
export function DdlTab({ data }: { data: DiffResponse }) {
  const ctx = useSchemaContext();
  const b = data.base.versionNo;
  const t = data.target.versionNo;
  // Schema 가 다른 버전끼리면(전환 비교) 버전 번호만으로는 헷갈리므로 Schema 이름을 붙인다
  const isCrossSchema = data.base.schemaId !== data.target.schemaId;
  const baseLabel = isCrossSchema ? `${data.base.schemaName} v${b}` : `v${b}`;
  const targetLabel = isCrossSchema ? `${data.target.schemaName} v${t}` : `v${t}`;
  const forward = `${baseLabel} → ${targetLabel}`;
  const backward = `${targetLabel} → ${baseLabel}`;
  const flip = () => ctx.set({ base: data.target.id, target: data.base.id });
  return (
    <section aria-label="DDL">
      <div className={s.bar}>
        {/* 선택된 방향이 항상 앞에 온다. 방향을 바꾸면 두 버튼의 글자가 서로 바뀌므로 포커스는 앞 버튼에 그대로 둔다 */}
        <div className={s.seg} role="radiogroup" aria-label="DDL 방향" onKeyDown={(e) => handleRadioKeys(e, DIRECTIONS, 'forward', flip, false)}>
          <button type="button" role="radio" aria-checked tabIndex={0} className={s.on}>{forward}</button>
          <button type="button" role="radio" aria-checked={false} tabIndex={-1} onClick={flip}>{backward}</button>
        </div>
        <span className={s.spacer} />
        <button type="button" className={s.btn} disabled={!data.ddl}
          onClick={() => downloadText(`${safeFileName(data.target.schemaName)}_v${b}_to_v${t}.sql`, data.ddl)}>
          <Icon name="download" />.sql 다운로드
        </button>
        <CopyButton text={data.ddl} label="전체 복사" disabled={!data.ddl} />
      </div>
      {data.statements.length === 0 ? (
        <p className={s.empty}>적용할 DDL이 없습니다</p>
      ) : (
        data.statements.map((st, i) => <StatementBlock key={i} st={st} />)
      )}
    </section>
  );
}
