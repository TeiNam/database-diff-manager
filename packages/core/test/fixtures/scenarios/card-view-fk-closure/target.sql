/* Database : shop */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

CREATE TABLE `p` (
  `id` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `c` (
  `id` int NOT NULL,
  `pid` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_c_p` (`pid`),
  CONSTRAINT `fk_c_p` FOREIGN KEY (`pid`) REFERENCES `p` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `c2` (
  `id` int NOT NULL,
  `new_pid` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_c2_p` (`new_pid`),
  CONSTRAINT `fk_c2_p` FOREIGN KEY (`new_pid`) REFERENCES `p` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select `c`.`id` AS `cid`,`c2`.`new_pid` AS `pid` from (`c` join `c2` on((`c2`.`id` = `c`.`id`)));

SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
