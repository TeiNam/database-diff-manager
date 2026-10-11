/* Database : shop */
CREATE TABLE `shipment` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `region` int NOT NULL,
  PRIMARY KEY (`id`,`region`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
/*!50100 PARTITION BY LIST (`region`)
(PARTITION p_metro VALUES IN (1,2) ENGINE = InnoDB,
 PARTITION p_south VALUES IN (3) ENGINE = InnoDB) */;
