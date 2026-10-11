-- [~] TABLE shipment
-- [데이터 확인] p_jeju: 파티션을 삭제하면 그 안의 행도 함께 삭제됩니다
ALTER TABLE `shipment` DROP PARTITION `p_jeju`;

-- [~] TABLE shipment
ALTER TABLE `shipment` REORGANIZE PARTITION `p_seoul`, `p_metro` INTO (
 PARTITION `p_metro` VALUES IN (1,2) ENGINE = InnoDB);
