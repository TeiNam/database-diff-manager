import { parseMdDump, parseSqlDump, suggestTarget } from '@tdm/core';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSchemaInfo, useTree, useUpload } from '../../api/hooks';
import type { UploadResult } from '../../api/types';
import { Icon } from '../../components/Icon';
import { useSchemaContext } from '../../hooks/useSchemaContext';
import s from './UploadDialog.module.css';

interface Draft {
  file: File;
  databaseName: string;
  schemaName: string;
  note: string;
  warnings: number;
}

// 서버와 같은 core 파서로 미리 경고 수만 계산한다 (최종 판정은 서버가 다시 파싱해서 한다)
function previewWarnings(format: 'sql' | 'md', text: string): number {
  try {
    return (format === 'sql' ? parseSqlDump(text) : parseMdDump(text)).warnings.length;
  } catch {
    return 1;
  }
}

// 서버 규칙과 동일: 파일명 255자 이하, 경로 구분자 금지 / 이름은 trim 후 1~128자
const MAX_FILENAME = 255;
const MAX_NAME = 128;
const nameError = (v: string) => (v.trim().length === 0 ? '비어 있습니다' : v.trim().length > MAX_NAME ? `${MAX_NAME}자 이하여야 합니다` : '');

// 'host:port' 제안값이 없고 예전 이름 'host_port' Database 가 있으면 그쪽에 이어 쌓는다 (이력이 둘로 갈라지지 않게)
function knownDatabase(name: string, known: string[]): string {
  const legacy = name.replace(/:(\d+)$/, '_$1');
  return legacy !== name && !known.includes(name) && known.includes(legacy) ? legacy : name;
}

async function toDraft(file: File, fallbackDb: string, known: string[]): Promise<Draft | string> {
  if (file.name.length > MAX_FILENAME || /[/\\]/.test(file.name)) return `${file.name.slice(0, 40)}: 파일명이 ${MAX_FILENAME}자를 넘거나 / \\ 문자를 포함합니다`;
  const text = await file.text();
  const suggestion = suggestTarget(file.name, text);
  if (!suggestion.format) return `${file.name}: 지원하지 않는 형식입니다 (.sql, .md)`;
  return { file, databaseName: suggestion.databaseName ? knownDatabase(suggestion.databaseName, known) : fallbackDb, schemaName: suggestion.schemaName ?? '', note: '', warnings: previewWarnings(suggestion.format, text) };
}

const STATUS_TEXT = (r: UploadResult) => (r.status === 'ok' ? `v${r.versionNo} 생성` : r.status === 'duplicate' ? `중복: ${r.message ?? ''}` : `실패: ${r.message ?? ''}`);

export function UploadDialog({ onClose }: { onClose: () => void }) {
  const ctx = useSchemaContext();
  const tree = useTree();
  const schema = useSchemaInfo(ctx.schemaId);
  const upload = useUpload();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // 열릴 때 첫 포커스 가능 요소로 포커스를 옮기고, 닫히면 열었던 요소로 되돌린다
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addFiles = async (files: FileList | File[]) => {
    // 이미 담긴 파일·같은 묶음 안의 파일과 이름이 겹치면 제외한다 (서버는 meta 파일명이 유일해야 한다)
    const seen = new Set(drafts.map((d) => d.file.name));
    const duplicates: string[] = [];
    const accepted = [...files].filter((f) => {
      if (!seen.has(f.name)) { seen.add(f.name); return true; }
      duplicates.push(`${f.name}: 같은 이름의 파일이 이미 있습니다`);
      return false;
    });
    const known = (tree.data ?? []).map((d) => d.name);
    const results = await Promise.all(accepted.map((f) => toDraft(f, schema.data?.databaseName ?? '', known)));
    setDrafts((prev) => [...prev, ...results.filter((r): r is Draft => typeof r !== 'string')]);
    setRejected([...duplicates, ...results.filter((r): r is string => typeof r === 'string')]);
  };
  const update = (i: number, patch: Partial<Draft>) => setDrafts((prev) => prev.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };
  const ready = drafts.length > 0 && drafts.every((d) => !nameError(d.databaseName) && !nameError(d.schemaName));
  // 성공·중복은 목록에서 빼고, 실패한 파일만 남겨 고쳐서 다시 올릴 수 있게 한다
  const submit = () => upload.mutate({
    files: drafts.map((d) => d.file),
    meta: drafts.map((d) => ({ filename: d.file.name, databaseName: d.databaseName.trim(), schemaName: d.schemaName.trim(), ...(d.note.trim() ? { note: d.note.trim() } : {}) })),
  }, {
    onSuccess: (data) => {
      const done = new Set(data.results.filter((r) => r.status !== 'error').map((r) => r.filename));
      setDrafts((prev) => prev.filter((d) => !done.has(d.file.name)));
    },
  });

  // Tab 이동을 대화상자 안에서 순환시킨다
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className={s.backdrop} role="presentation" onClick={onClose}>
      <div ref={dialogRef} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="upload-title" onClick={(e) => e.stopPropagation()} onKeyDown={trapTab}>
        <header className={s.head}>
          <h2 id="upload-title">정의서 업로드</h2>
          <button type="button" className={s.iconBtn} aria-label="닫기" onClick={onClose}><Icon name="x" /></button>
        </header>
        <label className={`${s.drop} ${dragging ? s.dragging : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <Icon name="upload" size={20} />
          <span>td-export의 .sql / .md 파일을 끌어다 놓거나 눌러서 고르세요</span>
          <input type="file" multiple accept=".sql,.md" aria-label="파일 선택" className="visually-hidden"
            onChange={(e) => { if (e.target.files) void addFiles([...e.target.files]); e.target.value = ''; }} />
        </label>
        {rejected.map((r, i) => <p key={i} className={s.warn}>{r}</p>)}
        <datalist id="known-databases">{tree.data?.map((d) => <option key={d.id} value={d.name} />)}</datalist>
        {drafts.map((d, i) => (
          <fieldset key={`${d.file.name}-${i}`} className={s.row} aria-label={d.file.name}>
            <legend className={s.file}>{d.file.name}</legend>
            <label>Database<input list="known-databases" value={d.databaseName} onChange={(e) => update(i, { databaseName: e.target.value })} aria-label="Database" aria-invalid={d.databaseName.length > 0 && !!nameError(d.databaseName)} /></label>
            <label>Schema<input value={d.schemaName} onChange={(e) => update(i, { schemaName: e.target.value })} aria-label="Schema" aria-invalid={d.schemaName.length > 0 && !!nameError(d.schemaName)} /></label>
            <label>메모<input value={d.note} maxLength={500} onChange={(e) => update(i, { note: e.target.value })} aria-label="메모" /></label>
            {d.databaseName.trim().length > MAX_NAME && <span role="alert" className={s.warn}>Database: {nameError(d.databaseName)}</span>}
            {d.schemaName.trim().length > MAX_NAME && <span role="alert" className={s.warn}>Schema: {nameError(d.schemaName)}</span>}
            <span className={d.warnings ? s.warn : s.ok}>{d.warnings ? `미리보기 경고 ${d.warnings}건` : '미리보기 이상 없음'}</span>
            <button type="button" className={s.iconBtn} aria-label={`${d.file.name} 제외`} onClick={() => setDrafts((prev) => prev.filter((_, k) => k !== i))}><Icon name="x" /></button>
          </fieldset>
        ))}
        {upload.data && (
          <ul className={s.results} aria-label="업로드 결과">
            {upload.data.results.map((r) => (
              <li key={r.filename} className={s[r.status]}>
                <b>{r.filename}</b> <span>{STATUS_TEXT(r)}</span>
                {r.warnings.map((w, k) => <div key={k} className={s.warnLine}>{w.object} · 줄 {w.line} · {w.message}</div>)}
              </li>
            ))}
          </ul>
        )}
        {upload.error && <p role="alert" className={s.warn}>{upload.error.message}</p>}
        <footer className={s.foot}>
          <button type="button" className={s.btn} onClick={onClose}>닫기</button>
          <button type="button" className={`${s.btn} ${s.primary}`} disabled={!ready || upload.isPending} onClick={submit}>업로드 {drafts.length}개</button>
        </footer>
      </div>
    </div>
  );
}
