-- [-] TABLE c
ALTER TABLE `c`
  DROP FOREIGN KEY `fk_c_p`;

-- [-] TABLE d
ALTER TABLE `d`
  DROP FOREIGN KEY `fk_d_q`;

-- [-] TABLE e
ALTER TABLE `e`
  DROP FOREIGN KEY `fk_e_r`;

-- [~] TABLE p
ALTER TABLE `p`
  RENAME COLUMN `id` TO `new_id`;

-- [~] TABLE q
ALTER TABLE `q`
  MODIFY COLUMN `id` int NOT NULL DEFAULT '0' COMMENT '키' AFTER `name`;

-- [~] TABLE r
ALTER TABLE `r`
  MODIFY COLUMN `id` bigint NOT NULL;

-- [-] TABLE c
DROP TABLE `c`;

-- [-] TABLE d
DROP TABLE `d`;

-- [-] TABLE e
DROP TABLE `e`;
