-- [-] TABLE c
ALTER TABLE `c`
  DROP FOREIGN KEY `fk_c_p`;

-- [-] TABLE d
ALTER TABLE `d`
  DROP FOREIGN KEY `fk_d_q`;

-- [~] TABLE p
ALTER TABLE `p`
  ADD COLUMN `memo` varchar(50) DEFAULT NULL;

-- [~] TABLE q
ALTER TABLE `q`
  MODIFY COLUMN `id` bigint NOT NULL;

-- [-] TABLE c
DROP TABLE `c`;

-- [-] TABLE d
DROP TABLE `d`;
