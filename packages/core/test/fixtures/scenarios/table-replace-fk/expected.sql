-- [~] TABLE entry
ALTER TABLE `entry`
  DROP FOREIGN KEY `fk_entry_log`;

-- [>] TABLE log_2025
-- 얽힌 테이블 rename 을 한 문장으로 함께 적용합니다: log→log_2025, log_new→log
RENAME TABLE `log` TO `log_2025`, `log_new` TO `log`;

-- [~] TABLE entry
ALTER TABLE `entry`
  ADD CONSTRAINT `fk_entry_log` FOREIGN KEY (`log_id`) REFERENCES `log` (`id`);
