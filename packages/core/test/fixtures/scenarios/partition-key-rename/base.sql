/* Database : note */
CREATE TABLE `chat_history` (
  `chat_history_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `user_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '사용자 메시지',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 시간',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정 시간',
  PRIMARY KEY (`chat_history_id`,`create_at`),
  KEY `chat_history_user_id_create_at_IDX` (`user_id`,`create_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI 챗봇 대화 이력'
/*!50100 PARTITION BY RANGE (((year(`create_at`) * 100) + month(`create_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB) */;
