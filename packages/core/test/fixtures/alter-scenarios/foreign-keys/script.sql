CREATE TABLE coupon (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  member_id INT UNSIGNED,
  order_id INT,
  parent_id INT UNSIGNED,
  CONSTRAINT fk_coupon_member FOREIGN KEY (member_id) REFERENCES member (id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY ix_parent (parent_id) REFERENCES coupon (id)
) ENGINE=InnoDB;
ALTER TABLE orders ADD COLUMN coupon_id INT UNSIGNED, ADD CONSTRAINT fk_orders_coupon FOREIGN KEY (coupon_id) REFERENCES coupon (id);
ALTER TABLE orders DROP FOREIGN KEY orders_ibfk_1;
