/* Database : shop */
/* Table : post */
CREATE TABLE `post` (
  `id` int NOT NULL,
  `title` varchar(50) NOT NULL DEFAULT '',
  `memo` text,
  `note` tinytext,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
