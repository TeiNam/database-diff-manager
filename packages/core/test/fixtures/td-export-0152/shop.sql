/* Database : shop */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

/* Routines */
SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
DELIMITER ;;
CREATE DEFINER=`root`@`localhost` FUNCTION `tax`(a decimal(10,2)) RETURNS decimal(10,2)
    DETERMINISTIC
    COMMENT '세금 10%'
BEGIN RETURN a * 0.1; END;;
DELIMITER ;
SET SQL_MODE = @OLD_ROUTINE_SQL_MODE;
SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
DELIMITER ;;
CREATE DEFINER=`root`@`localhost` PROCEDURE `mark_paid`(IN p_id int)
    MODIFIES SQL DATA
BEGIN UPDATE orders SET status = 'paid' WHERE id = p_id; INSERT INTO order_audit(order_id) VALUES (p_id); END;;
DELIMITER ;
SET SQL_MODE = @OLD_ROUTINE_SQL_MODE;

/* Table : order_audit */
CREATE TABLE `order_audit` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


/* Table : orders */
CREATE TABLE `orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `amount` decimal(10,2) NOT NULL,
  `status` varchar(10) NOT NULL DEFAULT 'new',
  `note` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


/* Table : paid_orders */
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `paid_orders` AS select `orders`.`id` AS `id`,`orders`.`amount` AS `amount` from `orders` where (`orders`.`status` = 'paid');


/* Table : big_paid */
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `big_paid` AS select `paid_orders`.`id` AS `id` from `paid_orders` where (`paid_orders`.`amount` > 100);


SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
