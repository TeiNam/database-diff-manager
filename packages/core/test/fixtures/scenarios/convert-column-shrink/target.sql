/* Database : shop */
CREATE TABLE `article` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(700) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_article_title` (`title`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
