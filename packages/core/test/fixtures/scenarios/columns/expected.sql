-- [~] TABLE orders
ALTER TABLE `orders`
  DROP INDEX `ix_user`,
  DROP COLUMN `memo`,
  MODIFY COLUMN `status` varchar(32) NOT NULL COMMENT '주문 상태',
  ADD COLUMN `discount_amt` decimal(10,2) NOT NULL DEFAULT '0.00' AFTER `total_amt`,
  ADD INDEX `ix_orders_user_created` (`user_id`,`created_at` DESC),
  COMMENT='주문 정보';
