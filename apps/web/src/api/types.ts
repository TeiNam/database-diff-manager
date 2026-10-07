// apps/server 응답과 같은 모양을 유지한다 (서버 타입은 node 의존성이 있어 직접 import 하지 않는다)
import type { ParseWarning, RenameMapping, SchemaDiff, SchemaModel, SourceFormat, Statement } from '@tdm/core';

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
  renames: RenameMapping[];
}

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
