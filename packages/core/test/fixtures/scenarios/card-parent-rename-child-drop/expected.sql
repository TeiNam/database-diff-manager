-- [-] TABLE c
ALTER TABLE `c`
  DROP FOREIGN KEY `fk_c_p`;

-- [>] TABLE p2
RENAME TABLE `p` TO `p2`;

-- [-] TABLE c
DROP TABLE `c`;
