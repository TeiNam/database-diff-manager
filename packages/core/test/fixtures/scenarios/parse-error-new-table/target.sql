/* Database : shop */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

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

SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
