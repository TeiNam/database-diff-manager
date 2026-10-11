/* Database : note */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

CREATE TABLE `chat_history` (
  `chat_history_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `user_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '사용자 메시지',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 시간',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정 시간',
  PRIMARY KEY (`chat_history_id`,`created_at`),
  KEY `chat_history_user_id_create_at_IDX` (`user_id`,`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI 챗봇 대화 이력'
/*!50100 PARTITION BY RANGE (((year(`created_at`) * 100) + month(`created_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB) */;

SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
