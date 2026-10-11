/* Database : tdm_md */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

/* Table : esc */
CREATE TABLE `esc` (
  `id` int NOT NULL,
  `path` varchar(50) NOT NULL DEFAULT 'C:\\temp',
  `nl` varchar(20) DEFAULT 'a\nb',
  `star` varchar(20) DEFAULT '*x*' COMMENT 'see [doc](http://e.x) `code` <b>',
  `pipe` enum('a|b','c') DEFAULT 'a|b',
  `g1` varchar(40) GENERATED ALWAYS AS (concat(`path`,_utf8mb4'invisible')) VIRTUAL,
  `g2` int GENERATED ALWAYS AS ((`id` * 2)) STORED /*!80023 INVISIBLE */,
  `hid` int DEFAULT NULL /*!80023 INVISIBLE */,
  PRIMARY KEY (`id`),
  KEY `ix*1` (`path`),
  KEY `fx` ((lower(`path`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


/* Table : Order Items */
CREATE TABLE `Order Items` (
  `id` int NOT NULL,
  `qty` int NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='a * b <i>x</i>';


SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
