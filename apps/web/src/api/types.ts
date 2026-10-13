// apps/server 응답과 같은 모양을 유지한다 (서버 타입은 node 의존성이 있어 직접 import 하지 않는다)
import type { DmsWarning, MigrationFlow, ParseWarning, RenameMapping, SchemaDiff, SchemaModel, SourceFormat, Statement } from '@tdm/core';

// admin: 전부 + 계정 관리, dba: 데이터 변경 전부, viewer: 읽기 전용
export type Role = 'admin' | 'dba' | 'viewer';

export interface Me {
  id: number;
  username: string;
  role: Role;
}

export interface User extends Me {
  disabled: boolean;
  createdAt: string;
}

export interface TreeSchema {
  id: number;
  name: string;
  latestVersion: { id: number; versionNo: number; uploadedAt: string } | null;
}

export interface TreeDatabase {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  schemas: TreeSchema[];
}

export interface SchemaInfo {
  id: number;
  name: string;
  databaseId: number;
  databaseName: string;
}

export interface VersionMeta {
  id: number;
  schemaId: number;
  databaseId: number;
  databaseName: string;
  schemaName: string;
  versionNo: number;
  sourceFormat: SourceFormat;
  sourceFilename: string;
  note: string | null;
  uploadedBy: string;
  uploadedAt: string;
  derivedFrom?: DerivedFrom; // ALTER 적용으로 만든 버전에만 있다
}

export interface VersionSummary extends VersionMeta {
  changedObjects: number;
}

// objects.kind (루틴: td-export 0.1.52+ SQL)
export type ObjectKind = 'table' | 'view' | 'function' | 'procedure';

export interface VersionObject {
  objectId: number;
  kind: ObjectKind;
  name: string;
  revisionNo: number;
}

export interface VersionDetail {
  version: VersionMeta;
  model: SchemaModel;
  objects: VersionObject[];
}

export interface DiffResponse {
  base: VersionMeta;
  target: VersionMeta;
  baseModel: SchemaModel;
  targetModel: SchemaModel;
  diff: SchemaDiff;
  statements: Statement[];
  ddl: string;
  renames: SourcedRename[];
  staleModels?: StaleModel[]; // 예전 파서로 저장된 BASE·TARGET 버전 (16회차 2). 옛 응답에는 없다
}

// 저장 모델이 원문을 지금 파서로 다시 읽은 모델과 다른 버전 — 이 버전이 낀 diff 는 실행 문장이 없다
export interface StaleModel {
  side: 'base' | 'target';
  versionId: number;
  versionNo: number;
  reason: string;
}

// diff 에 적용된 rename 의 출처: DMS 전환 매핑 또는 화면에서 넣은 수동 매핑. 출처가 없으면 수동으로 본다
export type RenameSource = 'dms' | 'manual';
// reversed: 역쌍(target, base)에 저장된 수동 매핑을 뒤집어 적용한 것 (이 쌍에는 저장되어 있지 않다)
export type SourcedRename = RenameMapping & { source?: RenameSource; reversed?: boolean };

export interface UploadMeta {
  filename: string;
  databaseName: string;
  schemaName: string;
  note?: string;
}

export interface UploadResult {
  filename: string;
  status: 'ok' | 'duplicate' | 'error';
  versionId?: number;
  versionNo?: number;
  warnings: ParseWarning[];
  message?: string;
}

export interface ObjectHistory {
  object: { id: number; kind: ObjectKind; name: string; schemaId: number };
  revisions: { revisionNo: number; fidelity: string; parseError: string | null; firstVersion: { id: number; versionNo: number; uploadedAt: string } }[];
}

export interface MigrationMeta {
  id: number;
  fromSchemaId: number;
  toSchemaId: number;
  revision: number;
  filename: string;
  ruleCount: number;
  note: string | null;
  uploadedBy: string;
  uploadedAt: string;
}

export type MigrationFlowResponse =
  | { mapping: null }
  | { mapping: MigrationMeta; flow: MigrationFlow; warnings: DmsWarning[] };

export interface MigrationUploadInput {
  fromSchemaId: number;
  toSchemaId: number;
  filename: string;
  source: string;
  note?: string;
}

export interface MigrationUploadResult {
  migration: MigrationMeta;
  warnings: DmsWarning[];
}

// ALTER 적용으로 만든 버전 (서버 009)
export interface DerivedFrom {
  baseVersionNo: number;
  statementCount: number;
  defaults: { charset: string; collation: string };
}

export interface AlterChange {
  kind: 'table' | 'view' | 'function' | 'procedure';
  name: string;
  op: 'add' | 'drop' | 'modify' | 'rename';
}

export interface AlterRequest {
  script: string;
  filename?: string;
  note?: string;
  dryRun?: boolean;
  defaults?: { charset?: string; collation?: string };
}

export type AlterResponse =
  | { status: 'preview'; applied: number; changes: AlterChange[]; renames: RenameMapping[] }
  | { status: 'ok' | 'duplicate'; versionId: number; versionNo: number; applied: number; changes: AlterChange[] };

export interface Derivation {
  baseVersionId: number | null;
  baseVersionNo: number;
  script: string;
  statementCount: number;
  defaults: { charset: string; collation: string };
}
