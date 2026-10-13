RENAME TABLE member TO tmp_member, orders TO member, tmp_member TO orders;
CREATE TABLE tmp1 (id INT PRIMARY KEY);
CREATE TABLE tmp2 (id INT PRIMARY KEY, t1 INT, FOREIGN KEY (t1) REFERENCES tmp1 (id));
DROP TABLE IF EXISTS nope, tmp2, tmp1;
ALTER TABLE orders RENAME TO members_renamed;
