/* Database : shop */
CREATE TABLE `orders` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `addr2` varchar(100) NOT NULL,
  `addr3` varchar(100) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_addr2` (`addr3`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
