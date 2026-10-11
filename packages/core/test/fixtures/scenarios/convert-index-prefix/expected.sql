-- [~] TABLE article
ALTER TABLE `article`
  DROP INDEX `ix_article_title`,
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  ADD INDEX `ix_article_title` (`title`(191));
