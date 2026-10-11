/* Database : shop */
CREATE TABLE `lit` (
  `id` int NOT NULL AUTO_INCREMENT,
  `bin2` binary(2) DEFAULT 0x00FE,
  `flags` bit(3) DEFAULT b'110',
  `hid` varchar(8) DEFAULT NULL /*!80023 INVISIBLE */ COMMENT '숨김',
  `mem_col` int /*!50606 STORAGE DISK */ DEFAULT NULL,
  `fixed_col` int /*!50606 STORAGE DISK */ /*!50606 COLUMN_FORMAT FIXED */ DEFAULT '1',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `zip` (
  `id` int NOT NULL,
  `code` varchar(20) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_zip_code` (`code`) KEY_BLOCK_SIZE=4 COMMENT 'k'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8;
