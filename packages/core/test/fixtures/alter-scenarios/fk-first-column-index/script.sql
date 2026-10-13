-- _base.sql 의 orders: 이름 없는 FK orders_ibfk_1 + 첫 컬럼 이름 인덱스 member_id. 덤프만으로는 FK 의 자동 인덱스인지 알 수 없어 직접 만든 것으로 본다.
-- 덤프로 다시 만든 DB 에서는 member_id 가 직접 만든 인덱스라 MySQL 도 남긴다 (FK 컬럼으로 시작하는 복합 인덱스 추가, FK 이름 정리를 한 문장·두 문장으로)
ALTER TABLE orders ADD INDEX idx (member_id, amount);
ALTER TABLE orders DROP FOREIGN KEY orders_ibfk_1, ADD CONSTRAINT fk_orders_member FOREIGN KEY (member_id) REFERENCES member (id);
ALTER TABLE orders DROP FOREIGN KEY fk_orders_member;
ALTER TABLE orders ADD CONSTRAINT fk_orders_member2 FOREIGN KEY (member_id) REFERENCES member (id);
