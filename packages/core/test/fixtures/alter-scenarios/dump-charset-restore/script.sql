-- 리뷰 12회차 R12-2·Claude F1: mysqldump·phpMyAdmin 머리·꼬리와 mysqldump --routines 의 루틴 블록은 @@collation_connection·@@character_set_results 를 읽어 두었다 되돌린다.
-- 되돌린 연결은 처음과 같은 utf8mb4 라 그 뒤의 한글 COMMENT·DEFAULT 를 MySQL 이 그대로 저장한다 (11회차는 @@collation_connection 을 모르는 값으로 읽어 거부했다).
-- 실행 주석 /*!40101 … */ 은 이 실행기가 그대로 보내지 못해 벗겨 쓴다 — 감싼 꼴은 단위 테스트(client-charset.test.ts)가 본다
SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT;
SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS;
SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION;
SET NAMES utf8mb4;
ALTER TABLE member ADD COLUMN nick VARCHAR(20) COMMENT '별명';
SET @saved_cs_client      = @@character_set_client;
SET @saved_cs_results     = @@character_set_results;
SET @saved_col_connection = @@collation_connection;
SET character_set_client  = utf8mb4;
SET character_set_results = utf8mb4;
SET collation_connection  = utf8mb4_0900_ai_ci;
SET @saved_sql_mode       = @@sql_mode;
SET sql_mode              = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';
DELIMITER ;;
CREATE PROCEDURE p_kor()
    COMMENT '회원 정리'
BEGIN SELECT '안녕'; END ;;
DELIMITER ;
SET sql_mode              = @saved_sql_mode;
SET character_set_client  = @saved_cs_client;
SET character_set_results = @saved_cs_results;
SET collation_connection  = @saved_col_connection;
SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT;
SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS;
SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION;
ALTER TABLE member ADD COLUMN memo2 VARCHAR(20) DEFAULT '메모' COMMENT '회원 메모';
CREATE PROCEDURE p_after() SELECT 1;
