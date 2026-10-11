/* Database : shop */
CREATE TABLE `member` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `first_name` varchar(30) NOT NULL,
  `last_name` varchar(30) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_first` (`first_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
