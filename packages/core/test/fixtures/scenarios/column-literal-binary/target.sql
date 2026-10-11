/* Database : shop */
CREATE TABLE `lit` (
  `id` int NOT NULL,
  `b2` binary(2) DEFAULT 'B\0',
  `b4` varbinary(4) DEFAULT 'A''\r\\',
  `b5` varbinary(4) DEFAULT '\\0',
  `b6` varbinary(3) DEFAULT '\0''\\',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

