/* Database : shop */
/* Table : t */
CREATE TABLE `t` (
  `id` int NOT NULL,
  `name` varchar(20) NOT NULL,
  `u` binary(16) DEFAULT (uuid_to_bin(uuid())),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : t2 */
CREATE TABLE `t2` (
  `id` int NOT NULL,
  `at` datetime DEFAULT (now()),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : t3 */
CREATE TABLE `t3` (
  `id` int NOT NULL,
  `u` binary(16) DEFAULT (uuid_to_bin(uuid())),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
