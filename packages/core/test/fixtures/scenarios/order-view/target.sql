/* Database : shop */
CREATE TABLE `t1` (
  `a` int NOT NULL,
  `c` varchar(10) DEFAULT NULL,
  `b` int DEFAULT NULL,
  PRIMARY KEY (`a`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_a` AS select `t1`.`a` AS `a`,`t1`.`c` AS `c` from `t1`;
