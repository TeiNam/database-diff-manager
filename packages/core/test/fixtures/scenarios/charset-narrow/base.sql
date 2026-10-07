/* Database : shop */
/* Table : msg */
CREATE TABLE `msg` (
  `id` int NOT NULL,
  `title` varchar(50) NOT NULL DEFAULT '',
  `body` varchar(200) DEFAULT NULL,
  `memo` text,
  `qty` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
