-- [~] TABLE chat_log
-- [데이터 확인] p202510: 보관 기간 정리로 앞쪽 파티션을 삭제하면 그 안의 행도 함께 삭제됩니다
ALTER TABLE `chat_log` DROP PARTITION `p202510`;

-- [~] TABLE chat_log
ALTER TABLE `chat_log` REORGANIZE PARTITION `pmax` INTO (
 PARTITION `p202512` VALUES LESS THAN (202601) ENGINE = InnoDB,
 PARTITION `pmax` VALUES LESS THAN MAXVALUE ENGINE = InnoDB);
