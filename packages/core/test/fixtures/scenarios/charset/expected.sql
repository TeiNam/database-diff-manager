-- [~] TABLE memo
ALTER TABLE `memo` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- [~] TABLE memo
ALTER TABLE `memo`
  MODIFY COLUMN `body` varchar(200) NOT NULL DEFAULT '';

-- [~] TABLE notes
ALTER TABLE `notes`
  MODIFY COLUMN `title` varchar(80) NOT NULL DEFAULT '',
  MODIFY COLUMN `tag` varchar(10) DEFAULT NULL,
  DEFAULT CHARSET=utf8mb4,
  COLLATE=utf8mb4_0900_ai_ci;
