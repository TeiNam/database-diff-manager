/* Database : shop */
CREATE TABLE `lit` (
  `id` int NOT NULL AUTO_INCREMENT,
  `bin2` binary(2) DEFAULT 0x00FF,
  `flags` bit(3) DEFAULT b'101',
  `hid` varchar(5) DEFAULT NULL /*!80023 INVISIBLE */ COMMENT '숨김',
  `mem_col` int /*!50606 STORAGE MEMORY */ DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `zip` (
  `id` int NOT NULL,
  `code` varchar(20) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8;
