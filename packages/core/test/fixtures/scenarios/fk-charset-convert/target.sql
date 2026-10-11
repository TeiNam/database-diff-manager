/* Database : shop */
CREATE TABLE `member` (
  `code` varchar(10) NOT NULL,
  `name` varchar(20) NOT NULL,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `orders` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `member_code` varchar(10) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_orders_member` (`member_code`),
  CONSTRAINT `fk_orders_member` FOREIGN KEY (`member_code`) REFERENCES `member` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
