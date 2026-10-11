-- [~] TABLE c2
ALTER TABLE `c2`
  DROP FOREIGN KEY `fk_c2_p`;

-- [+] TABLE c
CREATE TABLE `c` (
  `id` int NOT NULL,
  `pid` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_c_p` (`pid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- [~] TABLE c2
ALTER TABLE `c2`
  DROP INDEX `ix_c2_p`,
  DROP COLUMN `pid`,
  ADD COLUMN `new_pid` int NOT NULL,
  ADD INDEX `ix_c2_p` (`new_pid`);

-- [~] TABLE c2
ALTER TABLE `c2`
  ADD CONSTRAINT `fk_c2_p` FOREIGN KEY (`new_pid`) REFERENCES `p` (`id`);

-- [+] TABLE c
ALTER TABLE `c`
  ADD CONSTRAINT `fk_c_p` FOREIGN KEY (`pid`) REFERENCES `p` (`id`);

-- [~] VIEW v
-- DEFINER 없이 생성합니다 — 실행한 사용자가 DEFINER 가 됩니다
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select `c`.`id` AS `cid`,`c2`.`new_pid` AS `pid` from (`c` join `c2` on((`c2`.`id` = `c`.`id`)));
