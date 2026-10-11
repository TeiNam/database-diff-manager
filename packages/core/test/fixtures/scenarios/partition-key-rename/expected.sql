-- [~] TABLE chat_history
-- 파티션 함수가 쓰는 컬럼(create_at)을 바꾸므로 파티션 재정의를 같은 ALTER 에 넣습니다 (따로 실행하면 error 3855)
ALTER TABLE `chat_history`
  RENAME COLUMN `create_at` TO `created_at`,
  RENAME COLUMN `update_at` TO `updated_at`
  PARTITION BY RANGE (((year(`created_at`) * 100) + month(`created_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB);
