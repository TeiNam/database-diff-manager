/* Database : shop */
/* Table : p */
CREATE TABLE `p` (
  `id` int NOT NULL,
  `name` varchar(20) NOT NULL,
  `memo` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : q */
CREATE TABLE `q` (
  `id` bigint NOT NULL,
  `name` varchar(20) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
