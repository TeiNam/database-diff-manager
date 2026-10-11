/* Database : shop */
CREATE TABLE `price` (
  `id` int NOT NULL,
  `amount` int NOT NULL,
  `total` int DEFAULT NULL,
  `taxed` int GENERATED ALWAYS AS ((`amount` * 2)) STORED,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
