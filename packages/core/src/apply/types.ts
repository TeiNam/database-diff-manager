// ALTER 스크립트 적용(apply) 공용 타입
import type { RenameMapping } from '../diff';
import type { ColumnFormat, ColumnStorage, ForeignKey, Index, SchemaModel } from '../model';

// 스키마 기본 문자셋·콜레이션: 문자셋 없이 쓴 CREATE TABLE 과 문자열을 반환하는 함수에 MySQL 은 DB 기본값을 쓰는데,
// td-export 덤프에는 DB 기본값이 없어 사용자가 정한다
export interface ApplyDefaults {
  charset: string;
  collation: string;
}

export interface ApplyOptions {
  schemaName: string; // `cur`.`t` 처럼 한정한 이름과 USE 는 이 스키마일 때만 받는다
  defaults?: Partial<ApplyDefaults>;
}

export interface ApplyError {
  index: number; // 1부터 (0: 특정 문장이 아님)
  line: number;
  statement: string; // 앞 500자
  reason: string;
}

export type ApplyResult =
  | { ok: true; model: SchemaModel; applied: number; renames: RenameMapping[]; defaults: ApplyDefaults } // defaults: MySQL 표기로 맞춘 스키마 기본값
  | { ok: false; error: ApplyError };

// 문장을 적용할 수 없을 때 (MySQL 이 거부하거나 1차 지원 범위 밖). 메시지는 화면에 그대로 보인다
export class ApplyFailure extends Error {}

export const fail = (reason: string): never => {
  throw new ApplyFailure(reason);
};

// 1차 지원 범위 밖이라 거부하는 메시지의 끝에 ' — ' 로 붙이는 안내 (화면에 그대로 보인다)
export const RE_EXPORT = 'td-export 로 다시 뽑아 올려 주세요';

export const MYSQL_DEFAULTS: ApplyDefaults = { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' };
// 스크립트에 SET SQL_MODE 가 없을 때 루틴에 붙는 SQL_MODE (MySQL 8.0/8.4 기본값)
export const DEFAULT_SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

export interface NowSpec {
  fsp?: number; // CURRENT_TIMESTAMP(n) 의 n (0 이면 없음)
}

// 사람이 쓴 기본값 (정규화 전)
export type DefaultSpec =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string } // 부호 포함 원문 ('-1', '0.5'). TRUE/FALSE 는 '1'/'0'
  | { kind: 'bit'; value: string } // b'101' 원문
  | ({ kind: 'now' } & NowSpec);

// 사람이 쓴 컬럼 정의 (정규화 전). type 은 normalizeUserType 을 거친 값
export interface ColumnSpec {
  name: string;
  type: string;
  charset?: string; // 쓴 그대로 (utf8 → utf8mb3 는 정규화 때)
  collation?: string;
  nullable?: boolean; // undefined: NULL/NOT NULL 을 쓰지 않음 (NULL 허용)
  default?: DefaultSpec;
  onUpdate?: NowSpec;
  autoIncrement: boolean;
  comment?: string;
  invisible: boolean;
  srid?: number;
  storage?: ColumnStorage;
  columnFormat?: ColumnFormat;
  primaryKey: boolean; // 컬럼 안 PRIMARY KEY (또는 KEY)
  unique: boolean; // 컬럼 안 UNIQUE [KEY]
}

export type Position = { first: true } | { after: string } | undefined;

// 인덱스 정의. named=false 면 이름은 '' 이고 적용할 때 MySQL 규칙으로 짓는다
export interface IndexItem {
  kind: 'index';
  index: Index;
  named: boolean;
}

// FK 정의. named=false 면 fk.name 은 '' 이고 '<테이블>_ibfk_N' 으로 짓는다. indexName: FOREIGN KEY 뒤에 쓴 인덱스 이름
export interface FkItem {
  kind: 'fk';
  fk: ForeignKey;
  indexName?: string;
  named: boolean;
}

export type ConstraintItem = IndexItem | FkItem;
export type TableItem = { kind: 'column'; spec: ColumnSpec } | ConstraintItem;
