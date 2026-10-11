/* Database : shop */
CREATE TABLE `orders` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `addr` varchar(100) NOT NULL,
  `addr2` varchar(100) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_addr2` (`addr2`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
