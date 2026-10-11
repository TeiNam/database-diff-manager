/* Database : shop */
CREATE TABLE `post` (
  `id` int NOT NULL AUTO_INCREMENT,
  `body` text,
  `code` varchar(700) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_post_code` (`code`),
  KEY `ix_post_body` (`body`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;
