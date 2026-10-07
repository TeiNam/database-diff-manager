/* Database : shop */
/* Table : users */
CREATE TABLE `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : a */
CREATE TABLE `a` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : b */
CREATE TABLE `b` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `a_id` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_b_a` (`a_id`),
  CONSTRAINT `fk_b_a` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
