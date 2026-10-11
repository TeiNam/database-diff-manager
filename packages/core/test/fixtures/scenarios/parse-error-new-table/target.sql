/* Database : shop */
CREATE TABLE `member` (
  `id` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `pe` (
  `id` int NOT NULL,
  `a` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix` (`a`) /*!80021 SECONDARY_ENGINE_ATTRIBUTE '{"y": 2}' */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `pe_child` (
  `id` int NOT NULL,
  `pe_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_pe_child_pe` (`pe_id`),
  CONSTRAINT `fk_pe_child_pe` FOREIGN KEY (`pe_id`) REFERENCES `pe` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `memo` (
  `id` int NOT NULL,
  `member_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_memo_member` (`member_id`),
  CONSTRAINT `fk_memo_member` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
