/* Database : shop */
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;

/* Table : items */
CREATE TABLE `items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL DEFAULT 'it''s',
  `path` varchar(20) DEFAULT 'a\\b',
  `word` varchar(10) DEFAULT 'NULL',
  `code` varchar(5) NOT NULL DEFAULT '',
  `nick` varchar(20) DEFAULT NULL,
  `price` decimal(5,2) NOT NULL DEFAULT '0.00',
  `qty` int NOT NULL DEFAULT '0',
  `born` date DEFAULT '2020-01-01',
  `kind` enum('a|b','c') NOT NULL DEFAULT 'a|b' COMMENT 'x|y',
  `memo` text COMMENT 'line1\nline2',
  `g` geometry NOT NULL,
  `owner_id` int unsigned DEFAULT NULL,
  `owner_no` int unsigned DEFAULT NULL,
  `cat_id` int unsigned DEFAULT NULL,
  `bin` varbinary(4) DEFAULT 'ab',
  `uid` varchar(36) NOT NULL DEFAULT (uuid()),
  `ts` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_owner` (`owner_id`,`owner_no`),
  KEY `ix_name` (`name`(10) DESC,`code`),
  SPATIAL KEY `sp_g` (`g`),
  KEY `fk_cat` (`cat_id`),
  KEY `ix_expr` ((lower(`name`)),(concat(`code`,_utf8mb4'x\'y')),((`qty` + 1)) DESC),
  FULLTEXT KEY `ft_name` (`name`,`memo`),
  CONSTRAINT `fk_cat` FOREIGN KEY (`cat_id`) REFERENCES `common`.`categories` (`id`),
  CONSTRAINT `fk_owner` FOREIGN KEY (`owner_id`, `owner_no`) REFERENCES `owners` (`id`, `no`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='상품|목록';


SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
