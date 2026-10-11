-- [~] TABLE tag
-- [데이터 확인] 문자셋이 좁아지는 컬럼: `name`(utf8mb4 → latin1). 대상 문자셋에 없는 문자가 있으면 엄격 모드에서는 오류(1366)로 실패하고, 아니면 '?'로 바뀝니다. 실행 전에 데이터를 확인하세요
ALTER TABLE `tag`
  MODIFY COLUMN `name` varchar(255) NOT NULL,
  DEFAULT CHARSET=latin1,
  ROW_FORMAT=COMPACT;
