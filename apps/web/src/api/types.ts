// apps/server 응답과 같은 모양을 유지한다 (서버 타입은 node 의존성이 있어 직접 import 하지 않는다)
import type { DmsWarning, MigrationFlow, ParseWarning, RenameMapping, SchemaDiff, SchemaModel, SourceFormat, Statement } from '@tdm/core';

export type Role = 'admin' | 'viewer';

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
}

export interface VersionSummary extends VersionMeta {
  changedObjects: number;
}

export interface VersionObject {
  objectId: number;
  kind: 'table' | 'view';
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
}

// diff 에 적용된 rename 의 출처: DMS 전환 매핑 또는 화면에서 넣은 수동 매핑. 출처가 없으면 수동으로 본다
export type RenameSource = 'dms' | 'manual';
export type SourcedRename = RenameMapping & { source?: RenameSource };

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
  object: { id: number; kind: 'table' | 'view'; name: string; schemaId: number };
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
