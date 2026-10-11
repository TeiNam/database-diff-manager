-- [~] TABLE orders
-- RENAME INDEX x TO x: FK 를 다시 추가할 때 FK 가 만든 인덱스 이름이 FK 이름으로 바뀌지 않도록 고정합니다
-- FK 컬럼(또는 참조 컬럼)의 타입·문자셋·콜레이션이 바뀌어 FK 를 먼저 삭제하고 마지막에 다시 추가합니다 (error 3780)
ALTER TABLE `orders`
  DROP FOREIGN KEY `fk_orders_member`,
  RENAME INDEX `ix_orders_member` TO `ix_orders_member`;

-- [~] TABLE member
ALTER TABLE `member` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- [~] TABLE orders
ALTER TABLE `orders` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- [~] TABLE orders
ALTER TABLE `orders`
  ADD CONSTRAINT `fk_orders_member` FOREIGN KEY (`member_code`) REFERENCES `member` (`code`);
