-- [~] TABLE post
-- [데이터 확인] CONVERT TO가 넓힌 TEXT 계열 컬럼(`memo`, `note`)을 TARGET 타입으로 되돌립니다. 변환으로 길어진 값이 타입 한도를 넘으면 실패하거나 잘릴 수 있습니다
ALTER TABLE `post` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- [~] TABLE post
ALTER TABLE `post`
  MODIFY COLUMN `memo` text,
  MODIFY COLUMN `note` tinytext;
