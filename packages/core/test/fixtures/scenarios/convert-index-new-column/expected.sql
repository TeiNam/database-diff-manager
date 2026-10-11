-- [~] TABLE article
ALTER TABLE `article`
  DROP INDEX `ix_article_title`,
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  ADD COLUMN `slug` varchar(50) DEFAULT NULL,
  ADD INDEX `ix_article_title` (`title`(191)),
  ADD INDEX `ix_article_slug` (`slug`);
