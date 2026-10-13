// 루틴 특성의 기본값. SHOW CREATE 가 찍지 않는 값을 정하는 유일한 곳이다 (printRoutine·diff·ALTER 적용이 모두 여기를 따른다).
// 내부 모듈: src/index.ts 에서 내보내지 않는다 (공개 API 를 늘리지 않는다)
import type { RoutineCharacteristics } from './model';

const DEFAULTS = { deterministic: false, dataAccess: 'CONTAINS SQL', security: 'DEFINER', language: 'SQL' } satisfies RoutineCharacteristics;

// 기본값과 같은 명시 특성은 생략한 것과 같다 (NOT DETERMINISTIC·CONTAINS SQL·SQL SECURITY DEFINER·LANGUAGE SQL). comment 에는 기본값 항목이 없다
export const ROUTINE_DEFAULTS: Readonly<Record<string, unknown>> = DEFAULTS;

// SHOW CREATE 가 찍지 않는 값인가: 없거나 거짓(NOT DETERMINISTIC·빈 COMMENT)이거나 기본값과 같다
export const isDefaultCharacteristic = (name: string, value: unknown): boolean => !value || value === ROUTINE_DEFAULTS[name];
