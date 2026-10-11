/* Database : shop */
CREATE TABLE `member` (
  `id` int NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `point` (
  `id` int NOT NULL AUTO_INCREMENT,
  `member_id` int NOT NULL,
  `next_id` int GENERATED ALWAYS AS ((`member_id` + 1)) VIRTUAL,
  PRIMARY KEY (`id`),
  KEY `ix_point_member` (`member_id`),
  CONSTRAINT `fk_point_member` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
