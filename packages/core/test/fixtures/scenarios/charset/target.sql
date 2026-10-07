/* Database : shop */
/* Table : memo */
CREATE TABLE `memo` (
  `id` int NOT NULL,
  `body` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Table : notes */
CREATE TABLE `notes` (
  `id` int NOT NULL,
  `title` varchar(80) NOT NULL DEFAULT '',
  `code` varchar(10) CHARACTER SET latin1 COLLATE latin1_bin DEFAULT NULL,
  `tag` varchar(10) DEFAULT NULL,
  `qty` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
