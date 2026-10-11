/* Database : shop */
CREATE TABLE `post` (
  `id` int NOT NULL AUTO_INCREMENT,
  `body` text,
  `code` varchar(900) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_post_body` (`body`(1000)),
  KEY `ix_post_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 ROW_FORMAT=DYNAMIC;
