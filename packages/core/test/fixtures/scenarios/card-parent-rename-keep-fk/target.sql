/* Database : shop */
/* Table : p */
CREATE TABLE `p` (
  `new_id` int NOT NULL,
  `name` varchar(20) NOT NULL,
  PRIMARY KEY (`new_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : q */
CREATE TABLE `q` (
  `name` varchar(20) NOT NULL,
  `id` int NOT NULL DEFAULT '0' COMMENT '키',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : r */
CREATE TABLE `r` (
  `id` bigint NOT NULL,
  `name` varchar(20) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
