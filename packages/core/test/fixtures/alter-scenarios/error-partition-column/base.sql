/* Database : __DB__ */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

/* Table : logs */
CREATE TABLE `logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `created` date NOT NULL,
  `msg` varchar(100) DEFAULT NULL,
  `region` varchar(10) NOT NULL,
  PRIMARY KEY (`id`,`created`),
  KEY `ix_msg` (`msg`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
/*!50100 PARTITION BY RANGE (year(`created`))
(PARTITION p2023 VALUES LESS THAN (2024) ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE ENGINE = InnoDB) */;


/* Table : cols */
CREATE TABLE `cols` (
  `id` bigint NOT NULL,
  `created` date NOT NULL,
  `my col` varchar(10) NOT NULL,
  `msg` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`,`created`,`my col`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
/*!50500 PARTITION BY RANGE  COLUMNS(created,`my col`)
(PARTITION p1 VALUES LESS THAN ('2024-01-01','m') ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN (MAXVALUE,MAXVALUE) ENGINE = InnoDB) */;


/* Table : keyed */
CREATE TABLE `keyed` (
  `id` int NOT NULL,
  `a` int NOT NULL,
  `msg` varchar(10) DEFAULT NULL,
  PRIMARY KEY (`id`,`a`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
/*!50100 PARTITION BY KEY (id,a)
PARTITIONS 2 */;


SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
