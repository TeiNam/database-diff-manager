/* Database : shop */
CREATE TABLE `orders` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `qty` int NOT NULL,
  `price` int NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `orders_chk_1` CHECK ((`qty` > 0)),
  CONSTRAINT `orders_chk_2` CHECK ((`price` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
