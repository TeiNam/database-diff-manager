/* Database : shop */
CREATE TABLE `parent` (
  `id` int NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `child` (
  `id` int NOT NULL,
  `pid` int NOT NULL,
  `g` int GENERATED ALWAYS AS ((`id` + 1)) VIRTUAL,
  PRIMARY KEY (`id`),
  KEY `ix_child_parent` (`pid`),
  CONSTRAINT `fk_child_parent` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
