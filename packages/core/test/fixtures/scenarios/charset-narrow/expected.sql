-- [~] TABLE msg
-- [데이터 확인] 문자셋이 좁아지는 컬럼: `title`(utf8mb4 → latin1), `memo`(utf8mb4 → latin1). 대상 문자셋에 없는 문자가 있으면 엄격 모드에서는 오류(1366)로 실패하고, 아니면 '?'로 바뀝니다. 실행 전에 데이터를 확인하세요
ALTER TABLE `msg`
  MODIFY COLUMN `title` varchar(50) NOT NULL DEFAULT '',
  MODIFY COLUMN `body` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  MODIFY COLUMN `memo` text,
  DEFAULT CHARSET=latin1;
