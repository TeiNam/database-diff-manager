-- ENUM·SET 기본값의 멤버 찾기 (리뷰 3회차 R3-02·M-3): 기본 문자셋이 binary 인 테이블의 ENUM 은 SHOW CREATE 에 콜레이션이 없어도 binary 로 견준다 ('A' → 'A')
ALTER TABLE b ALTER COLUMN e SET DEFAULT 'A';
-- 언어별 콜레이션(utf8mb4_turkish_ci)도 글자까지 같은 멤버는 그 멤버다
ALTER TABLE tr ALTER COLUMN e SET DEFAULT 'ı', ADD t SET('i','ı') COLLATE utf8mb4_turkish_ci DEFAULT 'ı,i';
-- 엄격하지 않은 세션에서 만든 대소문자만 다른 멤버는 처음 맞는 멤버다 ('A' → 'a'). 엄격 SQL_MODE 는 이 테이블의 ALTER 를 1291 로 거부한다
SET SQL_MODE = 'NO_ENGINE_SUBSTITUTION';
ALTER TABLE d ALTER COLUMN e SET DEFAULT 'A';
SET SQL_MODE = DEFAULT;
