import { useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { ApiError } from '../../api/client';
import { useApplyAlter, useIsVersionMissing } from '../../api/hooks';
import type { AlterChange, AlterRequest, AlterResponse, VersionSummary } from '../../api/types';
import { Icon } from '../../components/Icon';
import { trapTab, useDialogFocus } from '../../hooks/useDialog';
import s from '../upload/UploadDialog.module.css';
import { readScriptFile } from './script-file';
import { useSchemaDefaults } from './useSchemaDefaults';

const OP_TEXT: Record<AlterChange['op'], string> = { add: '추가', drop: '삭제', modify: '변경', rename: '이름 변경' };
const KIND_TEXT: Record<AlterChange['kind'], string> = { table: '테이블', view: '뷰', function: '함수', procedure: '프로시저' };

// 응답을 좌우하는 입력 (메모는 결과에 영향이 없어 뺀다). 미리보기는 이 입력으로 낸 것이어야 저장할 수 있다
interface RequestInputs {
  baseId: number;
  script: string;
  charset: string;
  collation: string;
}
// 마지막 응답과, 그 응답을 받은 요청의 입력
interface Outcome {
  response: AlterResponse;
  inputs: RequestInputs;
}

// 저장하고 나서 기준 버전이 되기를 기다리는 버전 (저장 응답의 버전 id·번호)
interface AwaitedBase {
  id: number;
  versionNo: number;
}

const isSameInputs = (a: RequestInputs, b: RequestInputs | undefined) =>
  b !== undefined && a.baseId === b.baseId && a.script === b.script && a.charset === b.charset && a.collation === b.collation;

// 스키마의 SQL 버전에 ALTER 스크립트를 적용해 새 버전을 만든다 (미리보기 → 저장). versions: 최신 버전이 앞
export function AlterDialog({ versions, onClose }: { versions: VersionSummary[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const candidates = versions.filter((v) => v.sourceFormat === 'sql');
  const [baseId, setBaseId] = useState(candidates[0]?.id);
  // 저장하고 나면 이어 쓰는 스크립트는 그때 만든(내용이 같은 버전이 이미 있었다면 그) 버전 위에 적용돼야 한다. 그 버전이 목록에 나타나는 대로 기준 버전을 옮긴다.
  // 새 버전은 목록을 다시 받아야 보이는데, 그 전에 옛 기준 버전으로 미리보기를 내면 새 버전의 변경을 건너뛰므로 그동안은 미리보기·저장을 막는다.
  // 내용이 같은 기존 버전도 같다 — 다른 사용자·탭이 방금 만든 버전이면 이 대화상자가 받아 둔 목록에는 아직 없다
  const [awaitedBase, setAwaitedBase] = useState<AwaitedBase>();
  const nextBase = candidates.find((v) => v.id === awaitedBase?.id);
  if (nextBase) {
    setBaseId(nextBase.id);
    setAwaitedBase(undefined);
  }
  // 목록을 다시 받아 마쳤는데도 기다리던 버전이 없다 (목록을 받지 못해 옛 목록이 남았거나, 그 사이 지워졌다). 기다려도 오지 않으니 알리고,
  // 옛 기준 버전으로 이어 쓰게 하지는 않는다 — 방금 저장한 변경이 빠진 결과가 나온다
  const missingBase = useIsVersionMissing(versions[0]?.schemaId, awaitedBase?.id) ? awaitedBase : undefined;
  // 고른 기준 버전이 지금 목록에 아직 있는지. 다른 곳에서 지워졌거나 목록이 다른 스키마의 것으로 바뀌었다면 없다 —
  // 그때는 미리보기·저장을 막아, 화면에 보이는 버전과 요청을 보내는 버전이 어긋나지 않게 한다
  const base = candidates.find((v) => v.id === baseId);
  const isBaseGone = base === undefined && candidates.length > 0;
  const defaults = useSchemaDefaults(versions, base?.id);
  const [script, setScript] = useState('');
  const [filename, setFilename] = useState<string>();
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<Outcome>();
  const [fileError, setFileError] = useState<string>();
  const alter = useApplyAlter();
  // 요청(미리보기·저장)이 가는 동안은 입력을 잠근다
  const isLocked = alter.isPending;
  // 파일 읽기처럼 비동기로 끝나는 변경이 도착했을 때의 잠금 상태 (그 변경이 든 클로저는 읽기를 시작한 렌더의 것이다)
  const isLockedNow = useRef(isLocked);
  useLayoutEffect(() => {
    isLockedNow.current = isLocked;
  });
  const inputs: RequestInputs | undefined = base && { baseId: base.id, script, charset: defaults.charset.trim(), collation: defaults.collation.trim() };
  // 미리보기는 그것을 낸 입력과 지금 입력이 같을 때만 남긴다. 직접 고칠 때만 지우면 안 된다 — 기본값은 목록을 다시 받을 때도 저절로 바뀌고
  // (다른 곳에서 ALTER 를 저장·삭제하면 제안 값이 달라진다), 그러면 미리보기를 낸 값과 다른 값으로 저장된다. 한 번 지운 미리보기는 입력이 되돌아와도 되살리지 않는다
  if (outcome?.response.status === 'preview' && !isSameInputs(outcome.inputs, inputs)) setOutcome(undefined);
  // 입력을 바꾸는 변경은 모두 여기를 거친다. 이전 미리보기·결과·오류는 새 입력과 맞지 않으므로 함께 지운다.
  // 요청이 가는 동안에는 바꾸지 않고 false 를 돌려준다: reset 은 진행 중인 요청의 완료 처리를 떼어 내, 요청은 가는데 결과가 화면에 오지 않고 잠금이 풀린다 (저장을 한 번 더 할 수 있다)
  const edit = (apply: () => void): boolean => {
    if (isLockedNow.current) return false;
    apply();
    setOutcome(undefined);
    setFileError(undefined);
    alter.reset();
    return true;
  };
  // 고르거나 끌어다 놓은 파일을 스크립트로 읽는다. 받지 못하면 이유를 알리고 지금 스크립트는 그대로 둔다
  const loadFile = async (file: File) => {
    const read = await readScriptFile(file);
    if ('error' in read) {
      setFileError(read.error);
      return;
    }
    const isApplied = edit(() => {
      setScript(read.text);
      setFilename(file.name);
    });
    if (!isApplied) setFileError(`${file.name}: 요청이 가는 동안에는 스크립트를 바꿀 수 없습니다 — 끝난 뒤 다시 골라 주세요`);
  };
  const finish = (response: AlterResponse, requested: RequestInputs) => {
    setOutcome({ response, inputs: requested });
    if (response.status === 'preview') return;
    // 새 버전('ok')도 내용이 같은 기존 버전('duplicate')도 목록에 나타나기를 기다린다. 목록에 이미 있는지는 여기서 가리지 않는다 —
    // 이 함수는 저장을 보낸 렌더의 것이라 그때 받아 둔 목록만 보인다. 이미 있다면 위에서 바로 기준 버전을 옮긴다
    setAwaitedBase({ id: response.versionId, versionNo: response.versionNo });
  };
  const submit = (dryRun: boolean) => {
    if (!inputs) return;
    const body: AlterRequest = { script, dryRun, defaults: { charset: inputs.charset, collation: inputs.collation }, ...(filename ? { filename } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    alter.mutate({ baseId: inputs.baseId, body }, { onSuccess: (response) => finish(response, inputs) });
  };
  const ready = base !== undefined && script.trim().length > 0 && !isLocked && !defaults.isWaiting && awaitedBase === undefined;
  const preview = outcome?.response.status === 'preview' ? outcome.response : undefined;
  const saved = outcome && outcome.response.status !== 'preview' ? outcome.response : undefined;
  return (
    <div className={s.backdrop} role="presentation" onClick={onClose}>
      <div ref={dialogRef} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="alter-title" onClick={(e) => e.stopPropagation()} onKeyDown={trapTab}>
        <header className={s.head}>
          <h2 id="alter-title">ALTER 적용</h2>
          <button type="button" className={s.iconBtn} aria-label="닫기" onClick={onClose}><Icon name="x" /></button>
        </header>
        {candidates.length === 0 && <p className={s.warn}>SQL 덤프로 올린 버전이 없습니다 — MD 버전에는 ALTER 를 적용할 수 없습니다</p>}
        {/* 요청이 가는 동안에는 입력을 잠가, 보낸 값과 화면의 값이 어긋나지 않게 한다 (저장 직후 메모를 고치면 성공 문구 옆에 저장하지 않은 메모가 보인다).
            스크립트 칸과 파일 상자도 같다 — 저장 중에 고치면 저장 결과가 화면에서 사라져, 저장됐는지 모른 채 한 번 더 저장하게 된다 */}
        <fieldset className={s.row} aria-label="기준 버전과 스키마 기본값" disabled={isLocked}>
          <label>기준 버전
            <select value={base?.id ?? ''} aria-label="기준 버전"
              onChange={(e) => { const id = Number(e.target.value); edit(() => { setBaseId(id); setAwaitedBase(undefined); }); }}>
              {isBaseGone && <option value="" disabled>기준 버전을 고르세요</option>}
              {candidates.map((v) => <option key={v.id} value={v.id}>v{v.versionNo} · {v.sourceFilename}</option>)}
            </select>
          </label>
          <label>스키마 기본 문자셋<input value={defaults.charset} aria-label="스키마 기본 문자셋" disabled={defaults.isWaiting}
            onChange={(e) => { const value = e.target.value; edit(() => defaults.changeCharset(value)); }} /></label>
          <label>스키마 기본 콜레이션<input value={defaults.collation} aria-label="스키마 기본 콜레이션" disabled={defaults.isWaiting}
            onChange={(e) => { const value = e.target.value; edit(() => defaults.changeCollation(value)); }} /></label>
          <label>메모<input value={note} maxLength={500} aria-label="메모" onChange={(e) => { if (!isLockedNow.current) setNote(e.target.value); }} /></label>
        </fieldset>
        {isBaseGone && <p role="alert" className={s.warn}>선택한 기준 버전이 목록에 없습니다 — 다른 곳에서 지웠을 수 있습니다. 기준 버전을 다시 고르세요</p>}
        {missingBase && (
          <p role="alert" className={s.warn}>
            v{missingBase.versionNo} 버전을 새로 받은 목록에서 찾지 못했습니다 — 목록을 다시 받지 못했거나 다른 곳에서 지웠을 수 있습니다.
            이전 기준 버전에 이어 쓰면 이 버전의 변경이 빠질 수 있으니, 대화상자를 닫았다 다시 열거나 기준 버전을 직접 고르세요
          </p>
        )}
        {defaults.isWaiting && <p className={s.warnLine}>기준 버전 테이블의 기본 문자셋을 읽는 중…</p>}
        {defaults.error && <p role="alert" className={s.warn}>{defaults.error}</p>}
        <ScriptDropBox onFile={loadFile} disabled={isLocked} />
        {fileError && <p role="alert" className={s.warn}>{fileError}</p>}
        <textarea className={`mono ${s.script}`} rows={10} spellCheck={false} aria-label="ALTER 스크립트" value={script} disabled={isLocked} placeholder="ALTER TABLE member ADD COLUMN nick VARCHAR(20);"
          onChange={(e) => { const value = e.target.value; edit(() => { setScript(value); setFilename(undefined); }); }} />
        <p className={s.warnLine}>
          받는 문장: ALTER·CREATE·DROP·RENAME TABLE, CREATE·DROP INDEX, CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW. VIEW·CHECK·생성 컬럼·식 기본값·파티션·문자셋 변환은 td-export 로 다시 뽑아 올려 주세요.
          이 도구는 MySQL 의 모든 검사를 재현하지 않아, 실제 DB 에서는 거부될 스크립트를 받을 수 있습니다.
        </p>
        {preview && (
          <ul className={s.results} aria-label="미리보기 결과">
            <li className={s.ok}><b>문장 {preview.applied}개 적용</b> <span>변경 객체 {preview.changes.length}개</span></li>
            {preview.changes.map((c) => <li key={`${c.kind}:${c.name}`}>{KIND_TEXT[c.kind]} <span className="mono">{c.name}</span> {OP_TEXT[c.op]}</li>)}
          </ul>
        )}
        {saved && <p role="status" className={s.ok}>{saved.status === 'ok' ? `v${saved.versionNo} 생성` : `v${saved.versionNo}와 내용이 같습니다`}</p>}
        {alter.error && <p role="alert" className={s.warn}>{errorText(alter.error)}</p>}
        <footer className={s.foot}>
          {/* 저장 직후 목록을 다시 받는 짧은 동안만 보인다. 푸터 안에 두어 나타났다 사라져도 다른 줄이 밀리지 않게 한다 */}
          {awaitedBase !== undefined && !missingBase && <span className={s.footHint}>새 기준 버전을 목록에 불러오는 중… 오래 걸리면 대화상자를 닫았다 다시 여세요</span>}
          <button type="button" className={s.btn} onClick={onClose}>닫기</button>
          <button type="button" className={s.btn} disabled={!ready} onClick={() => submit(true)}>미리보기</button>
          <button type="button" className={`${s.btn} ${s.primary}`} disabled={!ready || !preview} onClick={() => submit(false)}>저장</button>
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

// .sql 파일을 고르거나 끌어다 놓는 상자. 파일을 읽는 일은 부모가 한다 (잠겨 있을 때 받은 파일을 받을지도 부모가 정하고 이유를 알린다).
// 처리하지 않은 파일 드롭은 브라우저가 그 파일을 열어 화면을 벗어나므로, 잠겨 있어도 끌어 올 때와 놓을 때 기본 동작을 막는다
function ScriptDropBox({ onFile, disabled }: { onFile: (file: File) => void; disabled: boolean }) {
  const [dragging, setDragging] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <label className={`${s.drop} ${disabled ? s.dropDisabled : dragging ? s.dragging : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <Icon name="upload" size={20} />
      <span>.sql 파일을 고르거나 끌어다 놓거나, 아래에 스크립트를 붙여 넣으세요</span>
      <input type="file" accept=".sql" aria-label="스크립트 파일" className="visually-hidden" disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }} />
    </label>
  );
}
