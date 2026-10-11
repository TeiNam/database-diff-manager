-- [>] TABLE purchase
RENAME TABLE `orders` TO `purchase`;

-- [>] TABLE purchase
ALTER TABLE `purchase`
  DROP CHECK `purchase_chk_2`,
  ADD CONSTRAINT `purchase_chk_2` CHECK ((`price` > 0));
