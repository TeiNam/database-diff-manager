/* Database : __DB__ */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

/* Table : member */
CREATE TABLE `member` (
  `id` int NOT NULL,
  `a` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uf` ((ifnull(`a`,0))),
  UNIQUE KEY `ua` (`a`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


/* Table : t2 */
CREATE TABLE `t2` (
  `id` int NOT NULL,
  `a` int NOT NULL,
  `b` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ub` (`b`),
  UNIQUE KEY `uf` ((nullif(`a`,0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
