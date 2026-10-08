import type { Statement } from '@tdm/core';
import { renderDdl } from '@tdm/core';
import { useEffect, useRef, useState } from 'react';
import { useFreshDiff } from '../../api/hooks';
import type { DiffResponse } from '../../api/types';
import { Icon } from '../../components/Icon';
import { useSchemaContext } from '../../hooks/useSchemaContext';
import { copyText } from '../../lib/clipboard';
import { downloadText } from '../../lib/download';
import { handleRadioKeys } from '../../lib/radio-group';
import s from './DdlTab.module.css';

const COPY_FEEDBACK_MS = 2000;
const MARK = { add: '+', drop: '-', modify: '~', rename: '>' } as const;

// 복사 직전에 받은 최신 DDL 에 이 문장이 없으면 옛 내용을 복사하지 않는다
class StaleStatementError extends Error {}

type CopyState = 'idle' | 'done' | 'fail' | 'stale';
const COPY_MESSAGE: Record<CopyState, string> = { idle: '', done: '복사됨', fail: '복사 실패', stale: 'DDL이 바뀌었습니다. 다시 확인하세요' };

function CopyButton({ getText, label = '복사', disabled = false }: { getText: () => Promise<string>; label?: string; disabled?: boolean }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 언마운트 시 라벨 복귀 타이머 정리
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (next: Exclude<CopyState, 'idle'>) => {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPY_FEEDBACK_MS);
  };
  const message = COPY_MESSAGE[state];
  const copy = () => copyText(getText()).then(() => show('done'), (e: unknown) => show(e instanceof StaleStatementError ? 'stale' : 'fail'));
  return (
    <>
      <button type="button" className={s.btn} aria-label={label} disabled={disabled} onClick={copy}>
        <Icon name="copy" />{message || label}
      </button>
      {/* 스크린리더용 복사 결과 안내 (버튼 이름은 그대로 둔다) */}
      <span role="status" className="visually-hidden">{message}</span>
    </>
  );
}

// 파일명에 쓸 수 없는 문자를 '_'로 바꾼다
const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|\s]/g, '_');

function StatementBlock({ st, refresh }: { st: Statement; refresh: () => Promise<DiffResponse> }) {
  const header = `${MARK[st.op]} ${st.kind.toUpperCase()} ${st.object}`;
  const text = renderDdl([st]);
  const getText = async () => {
    const fresh = await refresh();
    if (!fresh.statements.some((x) => renderDdl([x]) === text)) throw new StaleStatementError();
    return text;
  };
  return (
    <section className={s.block} aria-label={header}>
      <div className={s.blockHead}>
        <code>-- [{MARK[st.op]}] {st.kind.toUpperCase()} {st.object}</code>
        <CopyButton getText={getText} />
      </div>
      <pre className={s.sql}>
        {st.notes?.map((n, i) => <span key={`${i}-${n}`} className={s.note}>{`-- ${n}`}{'\n'}</span>)}
        {st.comment ? st.sql : `${st.sql};`}
      </pre>
    </section>
  );
}

const DIRECTIONS = ['forward', 'backward'] as const;

// 앱은 DDL을 실행하지 않는다. 보여 주고 복사·다운로드만 한다.
// 다른 사용자가 매핑·rename 을 바꿨을 수 있어 복사·다운로드 직전에 최신 diff 를 다시 받아 그 결과를 쓴다
export function DdlTab({ data }: { data: DiffResponse }) {
  const ctx = useSchemaContext();
  const refresh = useFreshDiff(data.base.id, data.target.id);
  const [downloadFailed, setDownloadFailed] = useState(false);
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
        <button type="button" className={s.btn} disabled={!data.ddl} onClick={() => {
          setDownloadFailed(false);
          refresh().then((fresh) => downloadText(`${safeFileName(fresh.target.schemaName)}_v${b}_to_v${t}.sql`, fresh.ddl), () => setDownloadFailed(true));
        }}>
          <Icon name="download" />.sql 다운로드
        </button>
        <span role="status" className={downloadFailed ? s.error : 'visually-hidden'}>{downloadFailed ? '다운로드 실패: 최신 DDL을 받지 못했습니다' : ''}</span>
        <CopyButton getText={() => refresh().then((fresh) => fresh.ddl)} label="전체 복사" disabled={!data.ddl} />
      </div>
      {data.statements.length === 0 ? (
        <p className={s.empty}>적용할 DDL이 없습니다</p>
      ) : (
        data.statements.map((st, i) => <StatementBlock key={i} st={st} refresh={refresh} />)
      )}
    </section>
  );
}
