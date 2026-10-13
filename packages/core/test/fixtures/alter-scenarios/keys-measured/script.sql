ALTER TABLE member ADD COLUMN code VARCHAR(10), ADD UNIQUE KEY uq_code (code(10)), ADD FULLTEXT KEY ft_name (name);
CREATE TABLE flags (f TINYINT PRIMARY KEY);
ALTER TABLE orders ADD COLUMN flag TINYINT(1), ADD INDEX ix_amount_desc (amount DESC), ADD CONSTRAINT fk_flag FOREIGN KEY (flag) REFERENCES flags (f);
CREATE TABLE child_desc (id INT PRIMARY KEY, pid INT UNSIGNED, KEY ix_pid_desc (pid DESC), FOREIGN KEY (pid) REFERENCES member (id));
