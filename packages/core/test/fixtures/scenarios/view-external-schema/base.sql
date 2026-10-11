/* Database : shop */
CREATE TABLE `user` (
  `id` int NOT NULL,
  `payload` int DEFAULT NULL,
  `g` int GENERATED ALWAYS AS ((`id` + 1)) VIRTUAL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1 AS `u`;
