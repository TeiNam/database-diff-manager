// SQLite 백업: npm run backup -w @tdm/server -- <저장할 경로>
// VACUUM INTO 로 한 시점의 일관된 스냅샷을 만든다. 서버가 실행 중이어도 안전하다
// (운영 중에 .db 파일만 복사하면 -wal 에 있는 최근 커밋이 빠지거나 깨진 사본이 될 수 있다)
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { dbPath, loadConfig } from '../config';
import type { Db } from '../db/connection';

export function backupDb(db: Db, target: string): void {
  if (!target.trim()) throw new Error('백업 파일 경로가 비어 있습니다');
  const path = resolve(target);
  if (existsSync(path)) throw new Error(`백업 파일이 이미 있습니다: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  db.prepare('VACUUM INTO ?').run(path);
}

function main(): void {
  const target = process.argv[2];
  if (!target) throw new Error('사용법: npm run backup -w @tdm/server -- <저장할 경로>');
  const source = dbPath(loadConfig());
  // 백업은 원본을 바꾸지 않는다: 없는 DB 를 새로 만들거나 마이그레이션하지 않는다
  if (!existsSync(source)) throw new Error(`DB 파일이 없습니다: ${source}`);
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    backupDb(db, target);
    console.log(`백업했습니다: ${source} → ${resolve(target)}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
