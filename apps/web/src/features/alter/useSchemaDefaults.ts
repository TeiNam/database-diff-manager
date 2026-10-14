import { MYSQL_DEFAULTS, type ApplyDefaults } from '@tdm/core';
import { useState } from 'react';
import { useAlterDefaults } from '../../api/hooks';
import type { VersionSummary } from '../../api/types';
import { collationAfterCharset } from './schema-defaults';

export interface SchemaDefaults extends ApplyDefaults {
  isWaiting: boolean; // 기준 버전 테이블에서 첫 값을 읽는 중 — 그동안 칸을 잠그고 미리보기를 막는다
  error?: string; // 첫 값을 읽지 못해 MySQL 8 기본값을 채웠다
  changeCharset: (value: string) => void;
  changeCollation: (value: string) => void;
}

// 스키마 기본 문자셋·콜레이션 칸. 첫 값은 ① 이 스키마의 마지막 ALTER 적용 값, 없으면 ② 기준 버전 테이블의 최빈값(서버), 그것도 없으면 ③ MySQL 8 기본값이다.
// 칸을 한 번이라도 고치면 화면의 두 값 모두 사용자가 정한 값이 되어, 늦게 온 제안이나 기준 버전 변경이 덮어쓰지 않는다
export function useSchemaDefaults(versions: VersionSummary[], baseId: number | undefined): SchemaDefaults {
  const [chosen, setChosen] = useState<ApplyDefaults>();
  const lastApplied = versions.find((v) => v.derivedFrom)?.derivedFrom?.defaults;
  const lookupId = (lastApplied || chosen) ? undefined : baseId; // 이미 정해진 값이 있으면 묻지 않는다
  const lookup = useAlterDefaults(lookupId);
  const current = chosen ?? lastApplied ?? lookup.data?.defaults ?? MYSQL_DEFAULTS;
  return {
    charset: current.charset,
    collation: current.collation,
    isWaiting: lookupId !== undefined && lookup.isPending,
    ...(lookupId !== undefined && lookup.error ? { error: `기준 버전의 기본 문자셋을 읽지 못해 MySQL 8 기본값을 채웠습니다: ${lookup.error.message}` } : {}),
    changeCharset: (value) => setChosen({ charset: value, collation: collationAfterCharset(value, current.collation) }),
    changeCollation: (value) => setChosen({ charset: current.charset, collation: value }),
  };
}
