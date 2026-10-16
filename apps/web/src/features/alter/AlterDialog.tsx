import { useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { ApiError } from '../../api/client';
import { useApplyAlter, useIsVersionMissing, useRefreshVersions } from '../../api/hooks';
import type { AlterChange, AlterRequest, AlterResponse, PreviewBase, VersionFingerprint, VersionSummary } from '../../api/types';
import { Icon } from '../../components/Icon';
import { trapTab, useBackdropClose, useDialogFocus } from '../../hooks/useDialog';
import s from '../upload/UploadDialog.module.css';
import { readScriptFile } from './script-file';
import { rebaseNotice, useRebase, type StalePreview } from './useRebase';
import { useSchemaDefaults } from './useSchemaDefaults';

const OP_TEXT: Record<AlterChange['op'], string> = { add: '추가', drop: '삭제', modify: '변경', rename: '이름 변경' };
const KIND_TEXT: Record<AlterChange['kind'], string> = { table: '테이블', view: '뷰', function: '함수', procedure: '프로시저' };
const HTTP_CONFLICT = 409; // 서버가 알려 주는 '미리보기 뒤에 기준 버전이 바뀌었다(지문)' 나 '기준 버전보다 더 새 버전이 있다(details.latestVersion)'
// 서버의 409 메시지와 같은 문구다 — 어느 쪽이 먼저 알아채도 같은 안내가 나온다
const BASE_CHANGED_TEXT = '기준 버전이 바뀌었습니다 — 미리보기 뒤에 다른 곳에서 지우고 다시 올렸을 수 있습니다. 미리보기를 다시 실행하세요';

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

// 버전을 가리키는 id·번호: 저장하고 나서 기준 버전이 되기를 기다리는 버전(저장 응답, 더 새 버전이 있어 옮길 최신 버전), 사용자가 직접 고른 옛 기준 버전
interface AwaitedBase {
  id: number;
  versionNo: number;
}

const isVersionNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

// 409 의 details 가 알려 주는, 기준 버전보다 더 새 버전 ({ latestVersion: { id, versionNo } } — 서버 리뷰 5회차 M-2·6회차).
// 그 밖의 409(기준 버전 지문 불일치)나 모양이 맞지 않는 값이면 undefined
function newerVersionOf(details: unknown): AwaitedBase | undefined {
  if (typeof details !== 'object' || details === null || !('latestVersion' in details)) return undefined;
  const latest = details.latestVersion;
  if (typeof latest !== 'object' || latest === null || !('id' in latest) || !('versionNo' in latest)) return undefined;
  const { id, versionNo } = latest;
  return isVersionNumber(id) && isVersionNumber(versionNo) ? { id, versionNo } : undefined;
}

const isSameInputs = (a: RequestInputs, b: RequestInputs | undefined) =>
  b !== undefined && a.baseId === b.baseId && a.script === b.script && a.charset === b.charset && a.collation === b.collation;

// 미리보기를 낸 기준 버전(서버가 돌려준 지문)이 목록의 이 버전인지. ID 만으로는 알 수 없다 — 가장 큰 ID 의 버전을 지우면 다른 업로드가 그 ID 를 다시 쓴다.
// 스키마와 버전 번호(지워도 다시 쓰지 않는다)를 본다. 모델 해시는 목록에 없어 서버가 저장할 때 확인한다 (어긋나면 409).
// 지문이 없는 응답은 어느 버전인지 알 수 없으니 같다고 보지 않는다
const isSameBase = (fingerprint: VersionFingerprint | undefined, version: VersionSummary) =>
  fingerprint?.schemaId === version.schemaId && fingerprint.versionNo === version.versionNo;

// 미리보기 때 이미 기준 버전보다 더 새 SQL 버전이 있었다 (서버가 돌려준 latestVersionNo). 지문이 없는 응답은 위에서 버려진다
const staleOf = (previewBase: PreviewBase | undefined): StalePreview | undefined =>
  previewBase !== undefined && previewBase.latestVersionNo > previewBase.versionNo ? { versionNo: previewBase.versionNo, latestVersionNo: previewBase.latestVersionNo } : undefined;

// 스키마의 SQL 버전에 ALTER 스크립트를 적용해 새 버전을 만든다 (미리보기 → 저장). versions: 최신 버전이 앞
export function AlterDialog({ versions, onClose }: { versions: VersionSummary[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const backdrop = useBackdropClose(onClose);
  const candidates = versions.filter((v) => v.sourceFormat === 'sql');
  const [baseId, setBaseId] = useState(candidates[0]?.id);
  // 저장하고 나면 이어 쓰는 스크립트는 그때 만든(내용이 같은 버전이 이미 있었다면 그) 버전 위에 적용돼야 한다. 그 버전이 목록에 나타나는 대로 기준 버전을 옮긴다.
  // 새 버전은 목록을 다시 받아야 보이는데, 그 전에 옛 기준 버전으로 미리보기를 내면 새 버전의 변경을 건너뛰므로 그동안은 미리보기·저장을 막는다.
  // 내용이 같은 기존 버전도 같다 — 다른 사용자·탭이 방금 만든 버전이면 이 대화상자가 받아 둔 목록에는 아직 없다
  const [awaitedBase, setAwaitedBase] = useState<AwaitedBase>();
  // 사용자가 기준 버전 선택에서 직접 고른, 최신 SQL 버전(목록의 맨 앞)이 아닌 버전. 그 버전이 기준일 때만 저장에 allowHistoricalBase 를 보낸다 (리뷰 6회차).
  // 대화상자가 저절로 고른 기준(열 때의 최신, 저장·더 새 버전 뒤에 옮긴 버전)은 그 뒤 옛 버전이 돼도 일부러 고른 것이 아니다
  const [historicalPick, setHistoricalPick] = useState<AwaitedBase>();
  // 기준 버전보다 더 새 버전이 있으면(저장 409, 미리보기의 latestVersionNo) 목록을 새로 받아, 그 목록의 최신 SQL 버전이 목록에 나타나기를 기다린다
  const rebase = useRebase(versions[0]?.schemaId, (newest) => setAwaitedBase({ id: newest.id, versionNo: newest.versionNo }));
  // ID 만으로 찾지 않는다: 저장한 버전이 지워진 뒤 같은 ID 로 올라온 다른 버전(버전 번호가 다르다)으로 기준 버전을 옮기면 안 된다
  const nextBase = candidates.find((v) => awaitedBase !== undefined && v.id === awaitedBase.id && v.versionNo === awaitedBase.versionNo);
  if (nextBase) {
    setBaseId(nextBase.id);
    setAwaitedBase(undefined);
  }
  // 목록을 다시 받아 마쳤는데도 기다리던 버전이 없다 (목록을 받지 못해 옛 목록이 남았거나, 그 사이 지워졌다). 기다려도 오지 않으니 알리고,
  // 옛 기준 버전으로 이어 쓰게 하지는 않는다 — 방금 저장한 변경이 빠진 결과가 나온다
  const missingBase = useIsVersionMissing(versions[0]?.schemaId, awaitedBase?.id, awaitedBase?.versionNo) ? awaitedBase : undefined;
  // 고른 기준 버전이 지금 목록에 아직 있는지. 다른 곳에서 지워졌거나 목록이 다른 스키마의 것으로 바뀌었다면 없다 —
  // 그때는 미리보기·저장을 막아, 화면에 보이는 버전과 요청을 보내는 버전이 어긋나지 않게 한다
  const base = candidates.find((v) => v.id === baseId);
  const isBaseGone = base === undefined && candidates.length > 0;
  // 버전 번호까지 본다: 고른 버전이 지워진 뒤 같은 ID 를 물려받은 다른 버전은 고른 버전이 아니다
  const isHistoricalBase = base !== undefined && historicalPick?.id === base.id && historicalPick.versionNo === base.versionNo;
  const defaults = useSchemaDefaults(versions, base?.id);
  const [script, setScript] = useState('');
  const [filename, setFilename] = useState<string>();
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<Outcome>();
  // 미리보기를 낸 기준 버전이 지금 고른 기준 버전과 달라 미리보기를 지웠다 (다른 곳에서 지우고 같은 ID 로 다시 올린 경우)
  const [isBaseChanged, setIsBaseChanged] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const alter = useApplyAlter();
  const refreshVersions = useRefreshVersions();
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
  const preview = outcome?.response.status === 'preview' ? outcome.response : undefined;
  // 입력이 같아도 미리보기를 낸 기준 버전(서버 지문)이 지금 고른 버전과 다르면 버린다. 입력은 ID 로만 기준 버전을 가리키는데, 목록을 다시 받았을 때
  // 같은 ID 가 다른 버전을 가리킬 수 있다. 이 버전에 그대로 저장하면 미리보기와 다른 모델에 적용된다
  if (preview && base && !isSameBase(preview.base, base)) {
    setOutcome(undefined);
    setIsBaseChanged(true);
  }
  // 입력을 바꾸는 변경은 모두 여기를 거친다. 이전 미리보기·결과·오류는 새 입력과 맞지 않으므로 함께 지운다.
  // 요청이 가는 동안에는 바꾸지 않고 false 를 돌려준다: reset 은 진행 중인 요청의 완료 처리를 떼어 내, 요청은 가는데 결과가 화면에 오지 않고 잠금이 풀린다 (저장을 한 번 더 할 수 있다)
  const edit = (apply: () => void): boolean => {
    if (isLockedNow.current) return false;
    apply();
    setOutcome(undefined);
    setIsBaseChanged(false);
    setFileError(undefined);
    alter.reset();
    return true;
  };
  // 기준 버전을 직접 고른다. 목록의 맨 앞(최신 SQL 버전)이 아니면 옛 버전을 일부러 고른 것이다. 최신 버전을 찾던 중이면 늦게 온 목록으로 옮기지 않는다
  const pickBase = (id: number) => {
    const picked = candidates.find((v) => v.id === id);
    setBaseId(id);
    setAwaitedBase(undefined);
    setHistoricalPick(picked && picked !== candidates[0] ? { id: picked.id, versionNo: picked.versionNo } : undefined);
    rebase.cancel();
  };
  // 기준 버전보다 더 새 SQL 버전이 있다. 미리보기를 지우고 목록을 새로 받아 그 목록의 최신 버전으로 옮긴다 — 옮긴 버전에서 새 미리보기를 내야 저장할 수 있다
  const rebaseToNewest = (stale?: StalePreview) => {
    setOutcome(undefined);
    setHistoricalPick(undefined);
    rebase.start(stale);
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
    // 미리보기 때 이미 더 새 버전이 있었는데 사용자가 옛 버전을 고른 것이 아니다 (대화상자를 연 뒤 다른 사용자가 저장했다 — 리뷰 6회차 Claude M-1). 그대로 저장하면
    // 그 버전의 변경이 빠지므로 이 미리보기는 남기지 않는다. 지문이 화면의 기준 버전과 다르면 목록이 낡은 것이라 아래에서 목록부터 맞춘다
    const stale = response.status === 'preview' && base && isSameBase(response.base, base) && !isHistoricalBase ? staleOf(response.base) : undefined;
    if (stale) {
      rebaseToNewest(stale);
      return;
    }
    setOutcome({ response, inputs: requested });
    if (response.status === 'preview') {
      // 서버가 본 기준 버전이 화면 목록의 것과 다르면 목록이 낡은 것이다. 이 미리보기는 위에서 버려지니, 목록을 다시 받아 기준 버전을 맞춘다
      if (base && !isSameBase(response.base, base)) refreshVersions();
      return;
    }
    // 새 버전('ok')도 내용이 같은 기존 버전('duplicate')도 목록에 나타나기를 기다린다. 목록에 이미 있는지는 여기서 가리지 않는다 —
    // 이 함수는 저장을 보낸 렌더의 것이라 그때 받아 둔 목록만 보인다. 이미 있다면 위에서 바로 기준 버전을 옮긴다
    setAwaitedBase({ id: response.versionId, versionNo: response.versionNo });
  };
  const submit = (dryRun: boolean) => {
    if (!inputs) return;
    // 저장은 미리보기가 돌려준 기준 버전 지문을 함께 보낸다 — 서버가 그 버전이 지금도 그대로인지 확인한다
    const expectedBase = dryRun ? undefined : preview?.base;
    if (!dryRun && !expectedBase) return;
    const body: AlterRequest = {
      script, dryRun, defaults: { charset: inputs.charset, collation: inputs.collation },
      ...(expectedBase ? { expectedBase } : {}), ...(expectedBase && isHistoricalBase ? { allowHistoricalBase: true } : {}),
      ...(filename ? { filename } : {}), ...(note.trim() ? { note: note.trim() } : {}),
    };
    setIsBaseChanged(false);
    rebase.cancel(); // 지난 안내는 새 요청과 맞지 않는다 (최신 버전을 찾는 동안에는 요청을 보낼 수 없다)
    alter.mutate({ baseId: inputs.baseId, body }, {
      onSuccess: (response) => finish(response, inputs),
      onError: (error) => {
        if (!(error instanceof ApiError && error.status === HTTP_CONFLICT)) return;
        // 기준 버전보다 더 새 버전이 저장돼 있다(details.latestVersion). 그 버전이 아니라 새로 받은 목록의 최신 버전으로 옮긴다 — 409 를 받은 뒤 목록이 오는 사이 또
        // 다른 버전이 저장되면 그 버전도 옛 버전이라, 거기서 낸 미리보기로 저장하면 그 사이의 변경이 빠진다 (리뷰 6회차 Codex #1). 메시지는 아래 오류 줄에 나온다
        if (newerVersionOf(error.details)) {
          rebaseToNewest();
          return;
        }
        // 미리보기 뒤에 기준 버전이 바뀌었다(지문). 그 미리보기는 지우고 목록을 다시 받아 화면의 기준 버전을 서버의 것에 맞춘다
        setOutcome(undefined);
        refreshVersions();
      },
    });
  };
  const ready = base !== undefined && script.trim().length > 0 && !isLocked && !defaults.isWaiting && awaitedBase === undefined && !rebase.isFetching;
  const saved = outcome && outcome.response.status !== 'preview' ? outcome.response : undefined;
  const notice = rebaseNotice(rebase.state);
  return (
    <div className={s.backdrop} role="presentation" {...backdrop}>
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
              onChange={(e) => { const id = Number(e.target.value); edit(() => pickBase(id)); }}>
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
        {isBaseChanged && <p role="alert" className={s.warn}>{BASE_CHANGED_TEXT}</p>}
        {notice && <p role="alert" className={s.warn}>{notice}</p>}
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
          {/* 저장 직후나 더 새 버전을 알았을 때 목록을 다시 받는 짧은 동안만 보인다. 푸터 안에 두어 나타났다 사라져도 다른 줄이 밀리지 않게 한다 */}
          {(rebase.isFetching || (awaitedBase !== undefined && !missingBase)) && <span className={s.footHint}>새 기준 버전을 목록에 불러오는 중… 오래 걸리면 대화상자를 닫았다 다시 여세요</span>}
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
