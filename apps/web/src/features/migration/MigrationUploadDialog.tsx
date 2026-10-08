import { parseDmsMapping, type DmsMapping, type DmsWarning } from '@tdm/core';
import { useRef, useState } from 'react';
import { useUploadMigration } from '../../api/hooks';
import { Icon } from '../../components/Icon';
import { trapTab, useDialogFocus } from '../../hooks/useDialog';
import u from '../upload/UploadDialog.module.css';
import s from './migration.module.css';

// 서버 규칙과 동일: 파일명 255자 이하·경로 구분자 금지, 원문 20MB 이하
const MAX_FILENAME = 255;
const MAX_BYTES = 20 * 1024 * 1024;

export interface SchemaRef {
  id: number;
  name: string;
}

interface Preview {
  filename: string;
  source: string;
  mapping: DmsMapping;
  warnings: DmsWarning[];
}

// 서버와 같은 core 파서로 미리 해석한다 (최종 판정은 서버가 다시 파싱해서 한다)
async function readPreview(file: File): Promise<Preview | string> {
  if (file.name.length > MAX_FILENAME || /[/\\]/.test(file.name)) return `파일명이 ${MAX_FILENAME}자를 넘거나 / \\ 문자를 포함합니다`;
  if (file.size > MAX_BYTES) return '파일이 너무 큽니다 (최대 20MB)';
  let source: string;
  try {
    source = await file.text();
  } catch {
    return '파일을 읽지 못했습니다';
  }
  try {
    return { filename: file.name, source, ...parseDmsMapping(source) };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function ruleCounts(m: DmsMapping, warnings: DmsWarning[]): [string, number][] {
  return [
    ['selection include', m.selection.include.length],
    ['selection exclude', m.selection.exclude.length],
    ['테이블 이름변경', m.tables.length],
    ['컬럼 이름변경', m.columns.length],
    ['컬럼삭제', m.removedColumns.length],
    ['스키마 이름변경', m.toSchema === undefined ? 0 : 1],
    ['반영하지 않는 룰', warnings.filter((w) => w.code === 'unsupported').length],
  ];
}

function SchemaCheck({ label, fileName, schema }: { label: string; fileName?: string; schema: SchemaRef }) {
  const isSame = fileName !== undefined && fileName.toLowerCase() === schema.name.toLowerCase();
  return (
    <li className={isSame ? u.ok : u.warn}>
      {label}: 파일 <code>{fileName ?? '(없음)'}</code> · Schema <code>{schema.name}</code> — {isSame ? '일치' : '다름 (그대로 올릴 수 있습니다)'}
    </li>
  );
}

function PreviewPanel({ preview, from, to }: { preview: Preview; from: SchemaRef; to: SchemaRef }) {
  const { mapping, warnings } = preview;
  return (
    <section className={s.preview} aria-label="미리보기">
      <p className={s.headTitle}>{preview.filename} · 룰 {mapping.ruleCount.toLocaleString('en-US')}개</p>
      <ul className={s.counts} aria-label="룰 종류별 개수">
        {ruleCounts(mapping, warnings).map(([label, n]) => <li key={label}><span>{label}</span> <b>{n.toLocaleString('en-US')}</b></li>)}
      </ul>
      <ul className={s.checks} aria-label="Schema 이름 확인">
        <SchemaCheck label="As-Is" fileName={mapping.fromSchema} schema={from} />
        <SchemaCheck label="To-Be" fileName={mapping.toSchema} schema={to} />
      </ul>
      {warnings.length === 0 ? <p className={u.ok}>경고 없음</p> : (
        <details>
          <summary className={u.warn}>경고 {warnings.length}건</summary>
          <ul className={s.warnings}>{warnings.map((w, i) => <li key={`${w.ruleId}-${i}`}>rule {w.ruleId} · {w.message}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

// As-Is → To-Be Schema 쌍에 DMS 매핑을 새 리비전으로 올린다 (admin 만 연다. 서버도 다시 확인한다)
export function MigrationUploadDialog({ from, to, onClose }: { from: SchemaRef; to: SchemaRef; onClose: () => void }) {
  const upload = useUploadMigration();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const pickSeq = useRef(0); // 연속 선택 시 마지막에 고른 파일만 반영한다 (먼저 고른 파일이 늦게 읽혀도 무시)
  useDialogFocus(dialogRef, onClose);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    const seq = ++pickSeq.current;
    const result = await readPreview(file);
    if (seq !== pickSeq.current) return;
    upload.reset();
    setPreview(typeof result === 'string' ? undefined : result);
    setError(typeof result === 'string' ? `${file.name.slice(0, 40)}: ${result}` : '');
  };
  const submit = () => {
    if (!preview) return;
    const trimmed = note.trim();
    upload.mutate(
      { fromSchemaId: from.id, toSchemaId: to.id, filename: preview.filename, source: preview.source, ...(trimmed ? { note: trimmed } : {}) },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className={u.backdrop} role="presentation" onClick={onClose}>
      <div ref={dialogRef} className={u.dialog} role="dialog" aria-modal="true" aria-labelledby="migration-upload-title" onClick={(e) => e.stopPropagation()} onKeyDown={trapTab}>
        <header className={u.head}>
          <h2 id="migration-upload-title">전환 매핑 올리기</h2>
          <button type="button" className={u.iconBtn} aria-label="닫기" onClick={onClose}><Icon name="x" /></button>
        </header>
        <p className={s.meta}>As-Is <code>{from.name}</code> → To-Be <code>{to.name}</code> 쌍에 새 리비전으로 저장합니다. 최신 리비전이 diff 에 자동으로 반영됩니다.</p>
        <label className={u.drop}>
          <Icon name="upload" size={20} />
          <span>AWS DMS table-mapping JSON 파일 1개를 고르세요</span>
          <input type="file" accept=".json" aria-label="매핑 파일 선택" className="visually-hidden"
            onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {error && <p role="alert" className={u.warn}>{error}</p>}
        {preview && <PreviewPanel preview={preview} from={from} to={to} />}
        <label className={s.noteLabel}>메모
          <input className={s.search} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-label="메모" />
        </label>
        {upload.error && <p role="alert" className={u.warn}>{upload.error.message}</p>}
        <footer className={u.foot}>
          <button type="button" className={u.btn} onClick={onClose}>닫기</button>
          <button type="button" className={`${u.btn} ${u.primary}`} disabled={!preview || upload.isPending} onClick={submit}>매핑 올리기</button>
        </footer>
      </div>
    </div>
  );
}
