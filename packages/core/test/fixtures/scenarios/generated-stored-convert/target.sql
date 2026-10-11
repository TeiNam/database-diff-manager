/* Database : shop */
CREATE TABLE `price` (
  `id` int NOT NULL,
  `amount` int NOT NULL,
  `total` int GENERATED ALWAYS AS ((`amount` + 1)) STORED,
  `taxed` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
