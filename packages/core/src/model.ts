// 스키마 모델. 'unknown' 목록에 있는 속성은 출처(MD)에서 알 수 없으므로 diff에서 건너뛴다.
export type Fidelity = 'full' | 'partial';

export type ColumnField = 'charset' | 'collation' | 'default' | 'onUpdate' | 'generated' | 'invisible' | 'srid';

export interface Column {
  name: string;
  type: string; // 정규화된 타입 원문: 'varchar(32)', 'int unsigned', "enum('a','b')"
  charset?: string; // DDL에 명시된 경우만
  collation?: string;
  generated?: { expr: string; stored: boolean }; // expr은 바깥 괄호 안쪽 원문
  nullable: boolean;
  srid?: number;
  invisible: boolean;
  default?: string; // SQL 원문: "NULL", "'0'", "CURRENT_TIMESTAMP", "(uuid())". undefined = DEFAULT 절 없음
  onUpdate?: string;
  autoIncrement: boolean;
  comment?: string; // 디코딩된 값
  unknown?: ColumnField[];
}

export type IndexKind = 'PRIMARY' | 'UNIQUE' | 'INDEX' | 'FULLTEXT' | 'SPATIAL';
export type IndexField = 'kind' | 'partDetails' | 'partOrder' | 'using' | 'parser' | 'comment' | 'invisible';

export interface IndexPart {
  column?: string;
  expr?: string; // 함수형 키 파트: ((expr))의 안쪽
  length?: number; // prefix 길이
  desc: boolean;
}

export interface Index {
  name: string; // PK는 'PRIMARY'
  kind: IndexKind;
  parts: IndexPart[];
  using?: string;
  parser?: string;
  comment?: string;
  invisible: boolean;
  unknown?: IndexField[];
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string; // undefined = 기본(RESTRICT/NO ACTION)
  onUpdate?: string;
}

export interface Check {
  name: string;
  expr: string; // CHECK (...)의 안쪽
  enforced: boolean;
}

export interface TableOption {
  key: string; // 'ENGINE', 'DEFAULT CHARSET', 'COLLATE', 'ROW_FORMAT', 'COMMENT' …
  value: string; // SQL 원문 ('InnoDB', "'주문'")
}

export interface PartitionDef {
  name: string;
  def: string; // 이름 뒤 원문: "VALUES LESS THAN (202511) COMMENT = '…' ENGINE = InnoDB"
}

export interface Partitioning {
  version: string; // /*!50100 의 숫자
  clause: string; // 'PARTITION BY …' 전체 원문 (출력용)
  method: string; // 'RANGE', 'RANGE COLUMNS', 'HASH', 'LINEAR KEY' … (대문자)
  expr: string; // 분할 표현식 (괄호 안쪽 원문)
  count?: number; // PARTITIONS n
  partitions: PartitionDef[];
}

export type TableField = 'checks' | 'partition';

export interface Table {
  kind: 'table';
  name: string;
  columns: Column[];
  indexes: Index[];
  foreignKeys: ForeignKey[];
  checks: Check[];
  options: TableOption[];
  partition?: Partitioning;
  fidelity: Fidelity;
  unknown?: TableField[];
  comparableOptions?: string[]; // partial 출처에서 비교 가능한 옵션 키. undefined = 전부 비교
  parseError?: string;
  rawDdl?: string; // 파싱 실패 또는 왕복 불일치 시 정규화된 원문
}

export interface View {
  kind: 'view';
  name: string;
  algorithm?: string;
  security?: string;
  checkOption?: string; // 'CASCADED' | 'LOCAL'
  columnList?: string; // VIEW `v` (…) 의 안쪽 원문
  body: string; // AS 뒤 SELECT 원문
  fidelity: Fidelity;
  parseError?: string;
  rawDdl?: string;
}

export interface SchemaModel {
  name: string;
  tables: Table[];
  views: View[];
}
