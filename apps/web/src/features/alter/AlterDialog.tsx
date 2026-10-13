import { useRef, useState, type DragEvent } from 'react';
import { ApiError } from '../../api/client';
import { useApplyAlter } from '../../api/hooks';
import type { AlterChange, AlterRequest, AlterResponse, VersionSummary } from '../../api/types';
import { Icon } from '../../components/Icon';
import { trapTab, useDialogFocus } from '../../hooks/useDialog';
import s from '../upload/UploadDialog.module.css';

const MYSQL_DEFAULTS = { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' };
const OP_TEXT: Record<AlterChange['op'], string> = { add: '추가', drop: '삭제', modify: '변경', rename: '이름 변경' };
const KIND_TEXT: Record<AlterChange['kind'], string> = { table: '테이블', view: '뷰', function: '함수', procedure: '프로시저' };
// 서버가 파일 이름을 .sql 로 끝나게 요구한다. 끌어다 놓기와 '모든 파일' 선택은 input 의 accept 필터를 거치지 않는다
const SQL_FILE = /\.sql$/i;

// 스키마의 SQL 버전에 ALTER 스크립트를 적용해 새 버전을 만든다 (미리보기 → 저장). versions: 최신 버전이 앞
export function AlterDialog({ versions, onClose }: { versions: VersionSummary[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const candidates = versions.filter((v) => v.sourceFormat === 'sql');
  const last = versions.find((v) => v.derivedFrom)?.derivedFrom?.defaults ?? MYSQL_DEFAULTS;
  const [baseId, setBaseId] = useState(candidates[0]?.id);
  const [script, setScript] = useState('');
  const [filename, setFilename] = useState<string>();
  const [note, setNote] = useState('');
  const [charset, setCharset] = useState(last.charset);
  const [collation, setCollation] = useState(last.collation);
  const [result, setResult] = useState<AlterResponse>();
  const [fileError, setFileError] = useState<string>();
  const alter = useApplyAlter();
  // 입력이 바뀌면 이전 미리보기·오류는 더 이상 맞지 않는다
  const edited = () => {
    setResult(undefined);
    setFileError(undefined);
    alter.reset();
  };
  // 고르거나 끌어다 놓은 파일을 스크립트로 읽는다. 받지 못하면 이유를 알리고 지금 스크립트는 그대로 둔다
  const loadFile = async (file: File) => {
    if (!SQL_FILE.test(file.name)) {
      setFileError(`${file.name}: .sql 파일만 받습니다`);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      setFileError(`${file.name}: 파일을 읽지 못했습니다${error instanceof Error && error.message ? ` (${error.message})` : ''}`);
      return;
    }
    setScript(text);
    setFilename(file.name);
    edited();
  };
  const submit = (dryRun: boolean) => {
    if (baseId === undefined) return;
    const body: AlterRequest = { script, dryRun, defaults: { charset: charset.trim(), collation: collation.trim() }, ...(filename ? { filename } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    alter.mutate({ baseId, body }, { onSuccess: setResult });
  };
  const ready = baseId !== undefined && script.trim().length > 0 && !alter.isPending;
  const saved = result && result.status !== 'preview' ? result : undefined;
  return (
    <div className={s.backdrop} role="presentation" onClick={onClose}>
      <div ref={dialogRef} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="alter-title" onClick={(e) => e.stopPropagation()} onKeyDown={trapTab}>
        <header className={s.head}>
          <h2 id="alter-title">ALTER 적용</h2>
          <button type="button" className={s.iconBtn} aria-label="닫기" onClick={onClose}><Icon name="x" /></button>
        </header>
        {candidates.length === 0 && <p className={s.warn}>SQL 덤프로 올린 버전이 없습니다 — MD 버전에는 ALTER 를 적용할 수 없습니다</p>}
        <fieldset className={s.row} aria-label="기준 버전과 스키마 기본값">
          <label>기준 버전
            <select value={baseId} aria-label="기준 버전" onChange={(e) => { setBaseId(Number(e.target.value)); edited(); }}>
              {candidates.map((v) => <option key={v.id} value={v.id}>v{v.versionNo} · {v.sourceFilename}</option>)}
            </select>
          </label>
          <label>스키마 기본 문자셋<input value={charset} aria-label="스키마 기본 문자셋" onChange={(e) => { setCharset(e.target.value); edited(); }} /></label>
          <label>스키마 기본 콜레이션<input value={collation} aria-label="스키마 기본 콜레이션" onChange={(e) => { setCollation(e.target.value); edited(); }} /></label>
          <label>메모<input value={note} maxLength={500} aria-label="메모" onChange={(e) => setNote(e.target.value)} /></label>
        </fieldset>
        <ScriptDropBox onFile={loadFile} />
        {fileError && <p role="alert" className={s.warn}>{fileError}</p>}
        <textarea className="mono" rows={10} spellCheck={false} aria-label="ALTER 스크립트" value={script} placeholder="ALTER TABLE member ADD COLUMN nick VARCHAR(20);"
          onChange={(e) => { setScript(e.target.value); setFilename(undefined); edited(); }} />
        <p className={s.warnLine}>
          받는 문장: ALTER·CREATE·DROP·RENAME TABLE, CREATE·DROP INDEX, CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW. VIEW·CHECK·생성 컬럼·식 기본값·파티션·문자셋 변환은 td-export 로 다시 뽑아 올려 주세요.
          이 도구는 MySQL 의 모든 검사를 재현하지 않아, 실제 DB 에서는 거부될 스크립트를 받을 수 있습니다.
        </p>
        {result?.status === 'preview' && (
          <ul className={s.results} aria-label="미리보기 결과">
            <li className={s.ok}><b>문장 {result.applied}개 적용</b> <span>변경 객체 {result.changes.length}개</span></li>
            {result.changes.map((c) => <li key={`${c.kind}:${c.name}`}>{KIND_TEXT[c.kind]} <span className="mono">{c.name}</span> {OP_TEXT[c.op]}</li>)}
          </ul>
        )}
        {saved && <p role="status" className={s.ok}>{saved.status === 'ok' ? `v${saved.versionNo} 생성` : `v${saved.versionNo}와 내용이 같습니다`}</p>}
        {alter.error && <p role="alert" className={s.warn}>{errorText(alter.error)}</p>}
        <footer className={s.foot}>
          <button type="button" className={s.btn} onClick={onClose}>닫기</button>
          <button type="button" className={s.btn} disabled={!ready} onClick={() => submit(true)}>미리보기</button>
          <button type="button" className={`${s.btn} ${s.primary}`} disabled={!ready || result?.status !== 'preview'} onClick={() => submit(false)}>저장</button>
        </footer>
      </div>
    </div>
  );
}

// 입력 검증 실패(zod)는 서버가 '입력값이 올바르지 않습니다' 와 함께 이유 목록(details)을 준다 — 스크립트 길이·문자셋 이름처럼 왜 틀렸는지 알 수 있게 첫 이유를 붙인다.
// 스크립트 적용 실패의 details 는 목록이 아니고, 메시지에 이미 이유가 있다
function errorText(error: Error): string {
  const first: unknown = error instanceof ApiError && Array.isArray(error.details) ? (error.details[0] as { message?: unknown } | undefined)?.message : undefined;
  return typeof first === 'string' && first ? `${error.message}: ${first}` : error.message;
}

// .sql 파일을 고르거나 끌어다 놓는 상자. 파일을 읽는 일은 부모가 한다.
// 처리하지 않은 파일 드롭은 브라우저가 그 파일을 열어 화면을 벗어나므로, 끌어 올 때와 놓을 때 기본 동작을 막는다
function ScriptDropBox({ onFile }: { onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <label className={`${s.drop} ${dragging ? s.dragging : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <Icon name="upload" size={20} />
      <span>.sql 파일을 고르거나 끌어다 놓거나, 아래에 스크립트를 붙여 넣으세요</span>
      <input type="file" accept=".sql" aria-label="스크립트 파일" className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }} />
    </label>
  );
}
