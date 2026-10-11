-- [-] TABLE c
ALTER TABLE `c`
  DROP FOREIGN KEY `fk_c_p`;

-- [>] TABLE p2
RENAME TABLE `p` TO `p2`;

-- [>] TABLE p2
ALTER TABLE `p2`
  ADD COLUMN `memo` varchar(50) DEFAULT NULL;

-- [-] TABLE c
DROP TABLE `c`;
