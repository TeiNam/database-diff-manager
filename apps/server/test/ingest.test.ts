import { beforeEach, describe, expect, it } from 'vitest';
import { one, openDb, type Db } from '../src/db/connection';
import { createUser } from '../src/repos/users';
import { deleteVersion, getSource, listVersions, loadVersion } from '../src/repos/versions';
import { ingest, modelHash } from '../src/services/ingest';
import { SAMPLE_MD, SAMPLE_SQL, sampleText } from './helpers';

const SQL = sampleText(SAMPLE_SQL);
const SQL_V2 = SQL.replace('`feature` varchar(50) NOT NULL', '`feature` varchar(80) NOT NULL');
const count = (db: Db, table: string) => one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;

let db: Db;
let userId: number;
const upload = (filename: string, text: string, schemaName = 'sample-app') =>
  ingest(db, { databaseName: '10.0.0.15', schemaName, filename, text, userId });

beforeEach(() => {
  db = openDb(':memory:');
  userId = createUser(db, { username: 'admin', passwordHash: 'h', role: 'admin' }).id;
});

describe('ingest', () => {
  it('첫 업로드는 v1, 33개 객체를 리비전 1로 저장한다', () => {
    const r = upload(SAMPLE_SQL, SQL);
    expect(r).toMatchObject({ status: 'ok', versionNo: 1, warnings: [] });
    expect(count(db, 'objects')).toBe(33);
    expect(count(db, 'object_revisions')).toBe(33);
    expect(count(db, 'version_objects')).toBe(33);
  });

  it('같은 내용(AUTO_INCREMENT만 다름)은 duplicate', () => {
    const first = upload(SAMPLE_SQL, SQL);
    const again = upload(SAMPLE_SQL, SQL.replace('AUTO_INCREMENT=15 ', 'AUTO_INCREMENT=999 '));
    expect(again).toMatchObject({ status: 'duplicate', versionNo: 1, versionId: first.status === 'ok' ? first.versionId : -1 });
    expect(count(db, 'schema_versions')).toBe(1);
  });

  it('변경된 객체만 새 리비전을 만든다', () => {
    upload(SAMPLE_SQL, SQL);
    expect(upload(SAMPLE_SQL, SQL_V2)).toMatchObject({ status: 'ok', versionNo: 2 });
    expect(count(db, 'object_revisions')).toBe(34);
    const [v2, v1] = listVersions(db, 1);
    expect([v2.versionNo, v2.changedObjects, v1.versionNo, v1.changedObjects]).toEqual([2, 1, 1, 33]);
  });

  it('MD 업로드는 partial 모델로 저장된다', () => {
    upload(SAMPLE_SQL, SQL);
    const r = upload(SAMPLE_MD, sampleText(SAMPLE_MD));
    expect(r).toMatchObject({ status: 'ok', versionNo: 2 });
    const detail = loadVersion(db, r.status === 'ok' ? r.versionId : 0);
    expect(detail.version).toMatchObject({ sourceFormat: 'md', databaseName: '10.0.0.15', schemaName: 'sample-app', uploadedBy: 'admin' });
    expect(detail.model.tables.every((t) => t.fidelity === 'partial')).toBe(true);
  });

  it('loadVersion·getSource', () => {
    const r = upload(SAMPLE_SQL, SQL);
    const id = r.status === 'ok' ? r.versionId : 0;
    const detail = loadVersion(db, id);
    expect(detail.model.name).toBe('sample-app');
    expect(detail.model.tables).toHaveLength(33);
    expect(detail.objects.find((o) => o.name === 'ai_usage_log')).toMatchObject({ kind: 'table', revisionNo: 1 });
    expect(getSource(db, id)).toEqual({ filename: SAMPLE_SQL, text: SQL });
  });

  it('버전 삭제는 고아 리비전을 정리하고 다른 버전은 그대로 둔다', () => {
    upload(SAMPLE_SQL, SQL);
    const v2 = upload(SAMPLE_SQL, SQL_V2);
    deleteVersion(db, v2.status === 'ok' ? v2.versionId : 0);
    expect(count(db, 'object_revisions')).toBe(33);
    expect(count(db, 'objects')).toBe(33);
    expect(listVersions(db, 1).map((v) => v.versionNo)).toEqual([1]);
    expect(() => loadVersion(db, 999)).toThrow('버전을 찾을 수 없습니다');
  });

  it('입력 오류', () => {
    expect(() => upload('a.xlsx', 'x')).toThrow('지원하지 않는 파일 형식');
    expect(() => upload('empty.sql', '/* Database : x */')).toThrow('테이블이나 뷰를 찾지 못했습니다');
    expect(() => upload('dup.sql', 'CREATE TABLE `a` (\n  `x` int\n);\nCREATE TABLE `a` (\n  `y` int\n);')).toThrow('같은 이름의 객체');
  });

  it('modelHash는 객체 순서에 무관하다', () => {
    const t = (name: string) => ({ kind: 'table' as const, name, columns: [], indexes: [], foreignKeys: [], checks: [], options: [], fidelity: 'full' as const });
    expect(modelHash({ name: 's', tables: [t('a'), t('b')], views: [] })).toBe(modelHash({ name: 's', tables: [t('b'), t('a')], views: [] }));
  });
});
