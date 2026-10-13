/* Database : __DB__ */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

/* Table : chk */
CREATE TABLE `chk` (
  `id` int NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `qty` int NOT NULL,
  `note` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_chk_1` CHECK ((`qty` >= 0)),
  CONSTRAINT `chk_price` CHECK ((`price` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


/* Table : chk_pair */
CREATE TABLE `chk_pair` (
  `id` int NOT NULL,
  `lo` int NOT NULL,
  `hi` int NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_pair_chk_1` CHECK ((`hi` < 1000)),
  CONSTRAINT `chk_pair_range` CHECK ((`lo` <= `hi`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
