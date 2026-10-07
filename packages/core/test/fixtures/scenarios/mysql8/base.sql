/* Database : shop */
CREATE TABLE `t2` (
  `a` int NOT NULL,
  `b` int GENERATED ALWAYS AS ((`a` * 2)) VIRTUAL,
  PRIMARY KEY (`a`),
  KEY `ix_b` (`b`),
  CONSTRAINT `chk_a` CHECK ((`a` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
