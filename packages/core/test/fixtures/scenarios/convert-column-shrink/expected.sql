-- [~] TABLE article
ALTER TABLE `article`
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  MODIFY COLUMN `title` varchar(700) DEFAULT NULL;
