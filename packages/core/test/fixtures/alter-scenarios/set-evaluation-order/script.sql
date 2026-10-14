-- 리뷰 11회차 Claude F2: 한 SET 문은 값을 모두 먼저 계산한 뒤 차례로 대입한다 (8.0.46·8.4.11 실측). 설정을 앞에 쓴 저장 'SET SQL_MODE = …, @OLD_SQL_MODE = @@SQL_MODE' 의
-- @OLD_SQL_MODE 는 문장 전의 값이라, 되돌린 뒤 만든 프로시저는 처음 세션 SQL_MODE(서버 기본 모드)를 기억한다. 앞 대입이 바꾼 사용자 변수를 뒤 대입이 읽어도 문장 전의 값이다
SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO', @OLD_SQL_MODE = @@SQL_MODE;
ALTER TABLE member ADD COLUMN nick VARCHAR(20);
SET SQL_MODE = @OLD_SQL_MODE;
CREATE PROCEDURE p_restored() SELECT 1;
SET @m = 'STRICT_TRANS_TABLES';
SET @m = 'NO_ENGINE_SUBSTITUTION', SQL_MODE = @m;
CREATE PROCEDURE p_old_value() SELECT 1;
SET SQL_MODE = DEFAULT;
