/* Database : shop */
CREATE TABLE `member` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(10) NOT NULL,
  `nick` varchar(20) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `uq_member_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `coupon` (
  `id` int NOT NULL AUTO_INCREMENT,
  `member_code` varchar(10) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_coupon_member` (`member_code`),
  CONSTRAINT `fk_coupon_member` FOREIGN KEY (`member_code`) REFERENCES `member` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `memo` (
  `id` int NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`),
  KEY `ix_memo_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
