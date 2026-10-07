CREATE TABLE `chat_history` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `conv` char(18) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '대화, 세션',
  `n` int(11) DEFAULT NULL,
  `flag` tinyint(1) NOT NULL DEFAULT '0',
  `kind` enum('a','b,c') NOT NULL DEFAULT 'a',
  `b` int GENERATED ALWAYS AS ((`n` * 2)) VIRTUAL,
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`,`create_at`),
  UNIQUE KEY `uk_conv` (`conv`(10)),
  KEY `ix_user` (`n`,`create_at` DESC) COMMENT 'idx',
  KEY `ix_fn` ((lower(`conv`))) /*!80000 INVISIBLE */,
  FULLTEXT KEY `ft` (`conv`) /*!50100 WITH PARSER `ngram` */ ,
  CONSTRAINT `fk_u` FOREIGN KEY (`n`) REFERENCES `other`.`users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_n` CHECK ((`n` > 0)) /*!80016 NOT ENFORCED */
) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI 챗봇'
/*!50100 PARTITION BY RANGE (((year(`create_at`) * 100) + month(`create_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE ENGINE = InnoDB) */