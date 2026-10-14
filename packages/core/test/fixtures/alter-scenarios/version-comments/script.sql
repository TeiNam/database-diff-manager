-- 리뷰 11회차 R11-2: MySQL 은 실행 주석의 버전 번호가 서버 버전 이하일 때만 안의 글을 실행한다 (8.0.46 은 80046 까지, 8.4.11 은 80411 까지 — 80500·99999 는 둘 다 건너뛴다).
-- 80046 이하와 번호 없는 '/*!' 는 두 버전이 모두 실행하고, 80500 이상은 모두 건너뛴다. 문장을 통째로 감싼 꼴(/*!99999 ALTER … */;)은 이 실행기가 여는 표지를 떼고 보내므로
-- 단위 테스트(version-comment.test.ts)가 본다
ALTER TABLE member ADD COLUMN v46 INT /*!80046 , ADD COLUMN v46b INT */;
ALTER TABLE member ADD COLUMN v500 INT /*!80500 , ADD COLUMN v500b INT */ /*!99999 , ADD COLUMN v99999 INT */;
CREATE TABLE vc (id INT PRIMARY KEY /*!99999 , phantom INT */, n INT /*!80023 INVISIBLE */) /*!99999 COMMENT 'skipped' */;
ALTER TABLE vc /*! ADD COLUMN bare INT */;
