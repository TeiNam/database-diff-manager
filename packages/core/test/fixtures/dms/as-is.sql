/* Database : legacy */
/* Table : tb_cust */
CREATE TABLE `tb_cust` (
  `cust_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `cust_nm` varchar(50) NOT NULL,
  `old_addr` varchar(200) DEFAULT NULL,
  `tmp_flag` char(1) DEFAULT NULL,
  PRIMARY KEY (`cust_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='고객';
/* Table : tb_prm */
CREATE TABLE `tb_prm` (
  `prm_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `prm_nm` varchar(100) NOT NULL,
  `max_dc_cnt` int DEFAULT NULL,
  `reg_dt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`prm_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='프로모션';
/* Table : tb_prm_cnd */
CREATE TABLE `tb_prm_cnd` (
  `cnd_seq` int unsigned NOT NULL AUTO_INCREMENT,
  `prm_id` bigint unsigned NOT NULL,
  `cnd_val` varchar(500) DEFAULT NULL,
  `use_yn` char(1) NOT NULL DEFAULT 'Y',
  PRIMARY KEY (`cnd_seq`),
  KEY `ix_cnd_prm` (`prm_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='프로모션 조건';
/* Table : tb_tmp_bak */
CREATE TABLE `tb_tmp_bak` (
  `id` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
