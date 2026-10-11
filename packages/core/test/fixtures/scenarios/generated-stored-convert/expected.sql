-- [~] TABLE price
ALTER TABLE `price`
  MODIFY COLUMN `total` int GENERATED ALWAYS AS ((`amount` + 1)) STORED,
  MODIFY COLUMN `taxed` int DEFAULT NULL;
