-- [-] TABLE b
ALTER TABLE `b`
  DROP FOREIGN KEY `fk_b_a`;

-- [-] TABLE a
DROP TABLE `a`;

-- [-] TABLE b
DROP TABLE `b`;
