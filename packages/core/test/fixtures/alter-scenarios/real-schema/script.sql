-- 사용자 전화번호 추가
ALTER TABLE `user` ADD COLUMN `phone` VARCHAR(20) NULL COMMENT '전화번호' AFTER `email`, ADD INDEX `idx_user_phone` (`phone`);
ALTER TABLE `user` MODIFY COLUMN `username` VARCHAR(30) NOT NULL COMMENT '유저명';
ALTER TABLE user_profile ADD COLUMN birth_date DATE NULL COMMENT '생일', DROP COLUMN instagram_url, DROP COLUMN linkedin_url;
ALTER TABLE user_login_log ADD COLUMN device VARCHAR(30) NULL COMMENT '기기', ADD INDEX ix_device (device);
CREATE TABLE `user_device` (
  `device_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` INT UNSIGNED NOT NULL COMMENT 'FK user_id',
  `token` VARCHAR(255) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`device_id`),
  UNIQUE KEY `uq_user_device_token` (`token`),
  KEY `ix_user_device_user` (`user_id`),
  CONSTRAINT `fk_user_device_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자 기기';
ALTER TABLE chat_history ADD COLUMN flagged CHAR(1) NOT NULL DEFAULT 'N' COMMENT '신고 여부' AFTER bot_response;
ALTER TABLE chat_history ADD INDEX ix_chat_flagged (flagged, create_at);
DROP TABLE vocabulary_review_log;
ALTER TABLE community_post COMMENT = '커뮤니티 게시글 (v2)';
RENAME TABLE diary TO diary_old;
