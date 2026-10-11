/* Database : shop */
CREATE TABLE `event_log` (
  `id` bigint unsigned NOT NULL,
  `logged_on` date NOT NULL,
  `message` varchar(50) NOT NULL,
  PRIMARY KEY (`id`,`logged_on`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
/*!50500 PARTITION BY RANGE  COLUMNS(logged_on)
(PARTITION p2025 VALUES LESS THAN ('2026-01-01') ENGINE = InnoDB,
 PARTITION p2026 VALUES LESS THAN ('2027-01-01') COMMENT = '2026년' ENGINE = InnoDB) */;
