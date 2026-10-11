/* Database : shop */
CREATE TABLE `purchase` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `qty` int NOT NULL,
  `price` int NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `purchase_chk_1` CHECK ((`qty` > 0)),
  CONSTRAINT `purchase_chk_2` CHECK ((`price` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
