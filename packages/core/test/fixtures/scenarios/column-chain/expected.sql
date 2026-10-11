-- [~] TABLE orders
ALTER TABLE `orders`
  RENAME COLUMN `addr` TO `addr2`,
  RENAME COLUMN `addr2` TO `addr3`;
