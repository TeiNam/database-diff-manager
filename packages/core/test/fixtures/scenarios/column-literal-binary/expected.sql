-- [~] TABLE lit
-- [NBE 세션 주의] 문자열 값에 백슬래시 이스케이프가 있어 NO_BACKSLASH_ESCAPES 세션에서 실행하면 값이 달라집니다 — 그 모드가 없는 세션에서 실행하세요
ALTER TABLE `lit`
  MODIFY COLUMN `b2` binary(2) DEFAULT 'B\0',
  MODIFY COLUMN `b4` varbinary(4) DEFAULT 'A''\r\\',
  ADD COLUMN `b6` varbinary(3) DEFAULT '\0''\\';
