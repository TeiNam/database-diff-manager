/* Database : shop */
CREATE TABLE `article` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(1000) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_article_title` (`title`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
