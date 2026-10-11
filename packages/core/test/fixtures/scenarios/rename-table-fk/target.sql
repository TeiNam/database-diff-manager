/* Database : shop */
CREATE TABLE `member` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `member_code` varchar(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`member_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `post` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `member_code` varchar(20) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_post_member` (`member_code`),
  CONSTRAINT `fk_post_member` FOREIGN KEY (`member_code`) REFERENCES `member` (`member_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
