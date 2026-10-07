-- [+] TABLE coupon
CREATE TABLE `coupon` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL,
  `code` varchar(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_coupon_code` (`code`),
  KEY `fk_coupon_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- [~] TABLE posts
ALTER TABLE `posts`
  ADD INDEX `fk_posts_user` (`user_id`);

-- [-] TABLE legacy_log
DROP TABLE `legacy_log`;

-- [~] TABLE posts
ALTER TABLE `posts`
  ADD CONSTRAINT `fk_posts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

-- [+] TABLE coupon
ALTER TABLE `coupon`
  ADD CONSTRAINT `fk_coupon_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);
