/* Database : sample-app */
/* Table : ai_usage_log */
CREATE TABLE `ai_usage_log` (
  `log_id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL,
  `feature` varchar(50) NOT NULL COMMENT 'youtube_summary, sentence_ai, exam_feedback, diary_ai 등',
  `model_id` tinyint unsigned DEFAULT NULL,
  `input_tokens` int unsigned DEFAULT NULL,
  `output_tokens` int unsigned DEFAULT NULL,
  `total_tokens` int unsigned DEFAULT NULL,
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`log_id`),
  KEY `ai_usage_log_user_id_IDX` (`user_id`,`create_at` DESC)
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='AI 기능별 사용량 로그';


/* Table : chat_history */
CREATE TABLE `chat_history` (
  `chat_history_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `conversation_id` char(18) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '대화 세션 식별자',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `user_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '사용자 메시지',
  `bot_response` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '봇 응답',
  `input_tokens` int unsigned DEFAULT NULL COMMENT '입력 토큰 수',
  `output_tokens` int unsigned DEFAULT NULL COMMENT '출력 토큰 수',
  `total_tokens` int unsigned DEFAULT NULL COMMENT '총 토큰 수',
  `model_id` tinyint unsigned DEFAULT NULL COMMENT 'FK model_id (논리적)',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 시간',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정 시간',
  PRIMARY KEY (`chat_history_id`,`create_at`),
  KEY `chat_history_conversation_id_IDX` (`conversation_id`),
  KEY `chat_history_user_id_create_at_IDX` (`user_id`,`create_at` DESC)
) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI 챗봇 대화 이력'
/*!50100 PARTITION BY RANGE (((year(`create_at`) * 100) + month(`create_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION p202512 VALUES LESS THAN (202601) COMMENT = '2025년 12월' ENGINE = InnoDB,
 PARTITION p202601 VALUES LESS THAN (202602) COMMENT = '2026년 1월' ENGINE = InnoDB,
 PARTITION p202602 VALUES LESS THAN (202603) COMMENT = '2026년 2월' ENGINE = InnoDB,
 PARTITION p202603 VALUES LESS THAN (202604) COMMENT = '2026년 3월' ENGINE = InnoDB,
 PARTITION p202604 VALUES LESS THAN (202605) COMMENT = '2026년 4월' ENGINE = InnoDB,
 PARTITION p202605 VALUES LESS THAN (202606) COMMENT = '2026년 5월' ENGINE = InnoDB,
 PARTITION p202606 VALUES LESS THAN (202607) COMMENT = '2026년 6월' ENGINE = InnoDB,
 PARTITION p202607 VALUES LESS THAN (202608) COMMENT = '2026년 7월' ENGINE = InnoDB,
 PARTITION p202608 VALUES LESS THAN (202609) COMMENT = '2026년 8월' ENGINE = InnoDB,
 PARTITION p202609 VALUES LESS THAN (202610) COMMENT = '2026년 9월' ENGINE = InnoDB,
 PARTITION p202610 VALUES LESS THAN (202611) COMMENT = '2026년 10월' ENGINE = InnoDB,
 PARTITION p202611 VALUES LESS THAN (202612) COMMENT = '2026년 11월' ENGINE = InnoDB,
 PARTITION p202612 VALUES LESS THAN (202701) COMMENT = '2026년 12월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB) */;


/* Table : community_comment */
CREATE TABLE `community_comment` (
  `comment_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `post_id` int unsigned NOT NULL COMMENT '게시글 ID (논리적 FK: community_post.post_id)',
  `user_id` int unsigned NOT NULL COMMENT '작성자 ID (논리적 FK: user.user_id)',
  `body` text COLLATE utf8mb4_general_ci NOT NULL COMMENT '댓글 내용',
  `is_active` char(1) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '활성화 여부',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '작성일',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일',
  PRIMARY KEY (`comment_id`),
  KEY `community_comment_user_id_IDX` (`user_id`),
  KEY `idx_community_comment_post_active_create` (`post_id`,`is_active`,`create_at`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='커뮤니티 댓글';


/* Table : community_like */
CREATE TABLE `community_like` (
  `like_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `post_id` int unsigned NOT NULL COMMENT '게시글 ID (논리적 FK: community_post.post_id)',
  `user_id` int unsigned NOT NULL COMMENT '사용자 ID (논리적 FK: user.user_id)',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '좋아요 시각',
  PRIMARY KEY (`like_id`),
  UNIQUE KEY `community_like_post_user_UIDX` (`post_id`,`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='커뮤니티 좋아요';


/* Table : community_post */
CREATE TABLE `community_post` (
  `post_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT '작성자 ID (논리적 FK: user.user_id)',
  `category` enum('youtube','podcast','website','app','tip','other') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'other' COMMENT '카테고리',
  `title` varchar(200) COLLATE utf8mb4_general_ci NOT NULL COMMENT '제목',
  `body` text COLLATE utf8mb4_general_ci NOT NULL COMMENT '본문 (마크다운)',
  `url` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '공유 링크 (YouTube/Podcast/사이트 URL)',
  `tags` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '태그 (콤마 구분)',
  `view_count` int unsigned NOT NULL DEFAULT '0' COMMENT '조회수',
  `like_count` int unsigned NOT NULL DEFAULT '0' COMMENT '좋아요 수',
  `comment_count` int unsigned NOT NULL DEFAULT '0' COMMENT '댓글 수',
  `is_active` char(1) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '활성화 여부',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '작성일',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일',
  PRIMARY KEY (`post_id`),
  KEY `community_post_create_at_IDX` (`create_at`),
  KEY `idx_community_post_category_active_create` (`category`,`is_active`,`create_at` DESC),
  KEY `idx_community_post_user_active` (`user_id`,`is_active`),
  FULLTEXT KEY `community_post_search_FTX` (`title`,`body`,`tags`) /*!50100 WITH PARSER `ngram` */ 
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='커뮤니티 게시글';


/* Table : conversation_practice_session */
CREATE TABLE `conversation_practice_session` (
  `session_id` char(18) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'PK - 세션 ID (nanoid)',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `prompt_template_id` tinyint unsigned NOT NULL COMMENT 'FK prompt_template_id (논리적) - 사용자 프롬프트',
  `model_id` tinyint unsigned NOT NULL DEFAULT '3' COMMENT 'FK model_id (논리적) - Realtime 모델',
  `voice` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'alloy' COMMENT '음성 (alloy, echo, shimmer)',
  `temperature` float NOT NULL DEFAULT '0.8' COMMENT '온도 (0.6-1.2)',
  `session_metadata` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '세션 메타데이터 (JSON) - 프롬프트 캐싱용',
  `status` enum('active','completed','error','cancelled') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active' COMMENT '세션 상태',
  `total_turns` int unsigned NOT NULL DEFAULT '0' COMMENT '총 대화 턴 수',
  `total_duration_seconds` int unsigned NOT NULL DEFAULT '0' COMMENT '총 대화 시간 (초)',
  `total_input_tokens` int unsigned NOT NULL DEFAULT '0' COMMENT '총 입력 토큰',
  `total_output_tokens` int unsigned NOT NULL DEFAULT '0' COMMENT '총 출력 토큰',
  `ai_feedback` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'AI 피드백 (JSON)',
  `overall_score` tinyint unsigned DEFAULT NULL COMMENT '총점 (0-100)',
  `fluency_score` tinyint unsigned DEFAULT NULL COMMENT '유창성 점수',
  `grammar_score` tinyint unsigned DEFAULT NULL COMMENT '문법 점수',
  `vocabulary_score` tinyint unsigned DEFAULT NULL COMMENT '어휘 점수',
  `pronunciation_score` tinyint unsigned DEFAULT NULL COMMENT '발음 점수',
  `content_score` tinyint unsigned DEFAULT NULL COMMENT '내용 점수',
  `feedback_input_tokens` int unsigned DEFAULT NULL COMMENT '피드백 생성 입력 토큰',
  `feedback_output_tokens` int unsigned DEFAULT NULL COMMENT '피드백 생성 출력 토큰',
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '에러 메시지',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '세션 시작 시간',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정 시간',
  `completed_at` datetime DEFAULT NULL COMMENT '세션 종료 시간',
  PRIMARY KEY (`session_id`),
  KEY `conversation_practice_session_user_id_IDX` (`user_id`,`create_at` DESC),
  KEY `conversation_practice_session_status_IDX` (`status`),
  KEY `conversation_practice_session_prompt_template_id_IDX` (`prompt_template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='회화 연습 세션';


/* Table : conversation_practice_turn */
CREATE TABLE `conversation_practice_turn` (
  `turn_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `session_id` char(18) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'FK conversation_practice_session.session_id (논리적)',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `turn_number` int unsigned NOT NULL COMMENT '턴 번호 (1부터 시작)',
  `user_audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '사용자 음성 URL (S3)',
  `user_transcription` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '사용자 발화 텍스트 (Whisper)',
  `ai_audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'AI 음성 URL (선택적 저장)',
  `ai_transcription` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'AI 응답 텍스트',
  `duration_seconds` int unsigned DEFAULT NULL COMMENT '턴 지속 시간 (초)',
  `input_tokens` int unsigned DEFAULT NULL COMMENT '입력 토큰',
  `output_tokens` int unsigned DEFAULT NULL COMMENT '출력 토큰',
  `timestamp_ms` bigint unsigned NOT NULL COMMENT '타임스탬프 (밀리초)',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 시간',
  PRIMARY KEY (`turn_id`,`create_at`),
  KEY `conversation_practice_turn_session_id_IDX` (`session_id`,`turn_number`),
  KEY `conversation_practice_turn_user_id_IDX` (`user_id`,`create_at` DESC)
) ENGINE=InnoDB AUTO_INCREMENT=43 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='회화 연습 대화 턴'
/*!50100 PARTITION BY RANGE (((year(`create_at`) * 100) + month(`create_at`)))
(PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION p202512 VALUES LESS THAN (202601) COMMENT = '2025년 12월' ENGINE = InnoDB,
 PARTITION p202601 VALUES LESS THAN (202602) COMMENT = '2026년 1월' ENGINE = InnoDB,
 PARTITION p202602 VALUES LESS THAN (202603) COMMENT = '2026년 2월' ENGINE = InnoDB,
 PARTITION p202603 VALUES LESS THAN (202604) COMMENT = '2026년 3월' ENGINE = InnoDB,
 PARTITION p202604 VALUES LESS THAN (202605) COMMENT = '2026년 4월' ENGINE = InnoDB,
 PARTITION p202605 VALUES LESS THAN (202606) COMMENT = '2026년 5월' ENGINE = InnoDB,
 PARTITION p202606 VALUES LESS THAN (202607) COMMENT = '2026년 6월' ENGINE = InnoDB,
 PARTITION p202607 VALUES LESS THAN (202608) COMMENT = '2026년 7월' ENGINE = InnoDB,
 PARTITION p202608 VALUES LESS THAN (202609) COMMENT = '2026년 8월' ENGINE = InnoDB,
 PARTITION p202609 VALUES LESS THAN (202610) COMMENT = '2026년 9월' ENGINE = InnoDB,
 PARTITION p202610 VALUES LESS THAN (202611) COMMENT = '2026년 10월' ENGINE = InnoDB,
 PARTITION p202611 VALUES LESS THAN (202612) COMMENT = '2026년 11월' ENGINE = InnoDB,
 PARTITION p202612 VALUES LESS THAN (202701) COMMENT = '2026년 12월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB) */;


/* Table : conversation_session */
CREATE TABLE `conversation_session` (
  `conversation_id` char(18) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'PK - 대화 세션 ID',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '대화 제목 (자동 생성 또는 사용자 지정)',
  `status` enum('active','archived','deleted') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active' COMMENT '대화 상태',
  `message_count` int unsigned NOT NULL DEFAULT '0' COMMENT '메시지 수',
  `summary` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '대화 요약 (AI 생성)',
  `category` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '대화 카테고리 (영어학습, 문법질문 등)',
  `tags` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '태그 (콤마 구분)',
  `total_input_tokens` int unsigned NOT NULL DEFAULT '0' COMMENT '총 입력 토큰',
  `total_output_tokens` int unsigned NOT NULL DEFAULT '0' COMMENT '총 출력 토큰',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 시간',
  `last_message_at` datetime NOT NULL COMMENT '마지막 메시지 시간',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정 시간',
  PRIMARY KEY (`conversation_id`),
  KEY `conversation_session_user_id_status_IDX` (`user_id`,`status`),
  KEY `conversation_session_user_id_last_msg_IDX` (`user_id`,`last_message_at` DESC),
  KEY `conversation_session_category_IDX` (`category`),
  KEY `idx_conversation_session_user_status_lastmsg` (`user_id`,`status`,`last_message_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='대화 세션 메타데이터';


/* Table : diary */
CREATE TABLE `diary` (
  `diary_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `date` date NOT NULL COMMENT '날짜',
  `body` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '본문',
  `feedback` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'AI 피드백',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`diary_id`),
  UNIQUE KEY `diary_user_id_date_UIDX` (`user_id`,`date` DESC),
  KEY `diary_date_IDX` (`date` DESC)
) ENGINE=InnoDB AUTO_INCREMENT=46 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='영어 일기';


/* Table : email_verification_token */
CREATE TABLE `email_verification_token` (
  `token_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `token` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '인증 토큰',
  `expires_at` datetime NOT NULL COMMENT '만료 시간',
  `verified_at` datetime DEFAULT NULL COMMENT '인증 완료 시간',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일자',
  PRIMARY KEY (`token_id`),
  UNIQUE KEY `email_verification_token_token_UIDX` (`token`),
  KEY `email_verification_token_user_id_IDX` (`user_id`),
  KEY `email_verification_token_expires_at_IDX` (`expires_at`)
) ENGINE=InnoDB AUTO_INCREMENT=92 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='이메일 인증 토큰';


/* Table : exam_answer_history */
CREATE TABLE `exam_answer_history` (
  `answer_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `question_id` int unsigned NOT NULL COMMENT 'FK exam_question.question_id (논리적)',
  `user_answer_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '사용자 답변 (텍스트)',
  `audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '음성 파일 URL (S3)',
  `transcription` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'Whisper 변환 텍스트',
  `ai_feedback` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'AI 피드백',
  `score` tinyint unsigned DEFAULT NULL COMMENT '점수 (0-100)',
  `fluency_score` tinyint unsigned DEFAULT NULL COMMENT '유창성 점수',
  `grammar_score` tinyint unsigned DEFAULT NULL COMMENT '문법 점수',
  `vocabulary_score` tinyint unsigned DEFAULT NULL COMMENT '어휘 점수',
  `pronunciation_score` tinyint unsigned DEFAULT NULL COMMENT '발음 점수',
  `content_score` tinyint unsigned DEFAULT NULL COMMENT '내용 점수',
  `duration_seconds` int unsigned DEFAULT NULL COMMENT '답변 시간 (초)',
  `model_id` tinyint unsigned DEFAULT NULL COMMENT 'FK model_id (논리적)',
  `input_tokens` int unsigned DEFAULT NULL COMMENT '입력 토큰 수',
  `output_tokens` int unsigned DEFAULT NULL COMMENT '출력 토큰 수',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '답변 시간',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정 시간',
  PRIMARY KEY (`answer_id`),
  KEY `exam_answer_history_question_id_IDX` (`question_id`),
  KEY `exam_answer_history_user_create_IDX` (`user_id`,`create_at` DESC),
  KEY `idx_exam_answer_user_question` (`user_id`,`question_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='시험 문제 답변 이력';


/* Table : exam_question */
CREATE TABLE `exam_question` (
  `question_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `exam_type` enum('OPIC','TOEIC_SPEAKING','TOEFL','IELTS','TEPS') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'OPIC' COMMENT '시험 유형',
  `section` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '섹션',
  `survey` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '서베이/주제',
  `question` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '질문',
  `is_active` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '활성화 여부',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`question_id`),
  KEY `idx_exam_question_type_active_section_survey` (`exam_type`,`is_active`,`section`,`survey`)
) ENGINE=InnoDB AUTO_INCREMENT=534 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='언어 시험 문제';


/* Table : grammar */
CREATE TABLE `grammar` (
  `grammar_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `title` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '타이틀',
  `body` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '내용 정리',
  `url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '강의 링크 URL',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`grammar_id`),
  KEY `grammar_user_id_create_at_IDX` (`user_id`,`create_at` DESC),
  FULLTEXT KEY `grammar_title_FTX` (`title`) /*!50100 WITH PARSER `ngram` */ 
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='문법 노트';


/* Table : learning_sentence */
CREATE TABLE `learning_sentence` (
  `sentence_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'user_id',
  `eng_sentence` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '영어 문장',
  `kor_sentence` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '한국어 의미',
  `note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '추가 설명',
  `category` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '카테고리 (구동사, 관용구, 일상표현 등)',
  `tags` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '태그 (콤마 구분)',
  `is_active` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '활성화 여부',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일',
  PRIMARY KEY (`sentence_id`),
  KEY `learning_sentence_category_IDX` (`category`),
  KEY `idx_learning_sentence_user_active_category` (`user_id`,`is_active`,`category`),
  FULLTEXT KEY `learning_sentence_content_FTX` (`eng_sentence`,`kor_sentence`,`note`,`tags`) /*!50100 WITH PARSER `ngram` */ 
) ENGINE=InnoDB AUTO_INCREMENT=359 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='학습 문장 (공용)';


/* Table : model */
CREATE TABLE `model` (
  `model_id` tinyint unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `vendor` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '제공사 (OpenAI, Anthropic, Google 등)',
  `region` varchar(20) COLLATE utf8mb4_general_ci DEFAULT 'ap-northeast-2' COMMENT 'AWS 리전',
  `ai_model` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'AI 모델명',
  `is_active` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '활성화 여부',
  `is_default` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '기본 모델 여부',
  `description` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '모델 설명',
  `max_context_tokens` int unsigned DEFAULT NULL COMMENT '최대 컨텍스트 토큰',
  `supports_function_calling` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '함수 호출 지원',
  `supports_vision` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '비전 지원',
  `input_price` decimal(10,3) NOT NULL DEFAULT '0.000' COMMENT 'Input 가격 (USD per 1M tokens)',
  `output_price` decimal(10,3) NOT NULL DEFAULT '0.000' COMMENT 'Output 가격 (USD per 1M tokens)',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`model_id`),
  UNIQUE KEY `model_ai_model_UIDX` (`ai_model`),
  KEY `model_vendor_IDX` (`vendor`),
  KEY `model_is_active_is_default_IDX` (`is_active`,`is_default`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI 모델 메타데이터';


/* Table : notification_log */
CREATE TABLE `notification_log` (
  `log_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `subscription_id` int unsigned NOT NULL COMMENT 'FK user_push_subscription.subscription_id (논리적)',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `platform` enum('web','android','ios') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '플랫폼 타입',
  `sent_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '발송 시간',
  `status` enum('success','failed','retry') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '발송 상태',
  `error_message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '에러 메시지',
  `message_title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '알림 제목',
  `message_body` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '알림 본문',
  `retry_count` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '재시도 횟수',
  `clicked_at` datetime DEFAULT NULL COMMENT '알림 클릭 시간',
  PRIMARY KEY (`log_id`,`sent_at`),
  KEY `notification_log_subscription_id_IDX` (`subscription_id`),
  KEY `notification_log_user_sent_IDX` (`user_id`,`sent_at` DESC),
  KEY `notification_log_status_IDX` (`status`),
  KEY `notification_log_platform_IDX` (`platform`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='알림 발송 이력 (웹/앱 통합)'
/*!50100 PARTITION BY RANGE (((year(`sent_at`) * 100) + month(`sent_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION p202512 VALUES LESS THAN (202601) COMMENT = '2025년 12월' ENGINE = InnoDB,
 PARTITION p202601 VALUES LESS THAN (202602) COMMENT = '2026년 1월' ENGINE = InnoDB,
 PARTITION p202602 VALUES LESS THAN (202603) COMMENT = '2026년 2월' ENGINE = InnoDB,
 PARTITION p202603 VALUES LESS THAN (202604) COMMENT = '2026년 3월' ENGINE = InnoDB,
 PARTITION p202604 VALUES LESS THAN (202605) COMMENT = '2026년 4월' ENGINE = InnoDB,
 PARTITION p202605 VALUES LESS THAN (202606) COMMENT = '2026년 5월' ENGINE = InnoDB,
 PARTITION p202606 VALUES LESS THAN (202607) COMMENT = '2026년 6월' ENGINE = InnoDB,
 PARTITION p202607 VALUES LESS THAN (202608) COMMENT = '2026년 7월' ENGINE = InnoDB,
 PARTITION p202608 VALUES LESS THAN (202609) COMMENT = '2026년 8월' ENGINE = InnoDB,
 PARTITION p202609 VALUES LESS THAN (202610) COMMENT = '2026년 9월' ENGINE = InnoDB,
 PARTITION p202610 VALUES LESS THAN (202611) COMMENT = '2026년 10월' ENGINE = InnoDB,
 PARTITION p202611 VALUES LESS THAN (202612) COMMENT = '2026년 11월' ENGINE = InnoDB,
 PARTITION p202612 VALUES LESS THAN (202701) COMMENT = '2026년 12월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB) */;


/* Table : password_reset_token */
CREATE TABLE `password_reset_token` (
  `token_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `token` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '재설정 토큰',
  `expires_at` datetime NOT NULL COMMENT '만료 시간',
  `used_at` datetime DEFAULT NULL COMMENT '사용 완료 시간',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일자',
  PRIMARY KEY (`token_id`),
  UNIQUE KEY `password_reset_token_token_UIDX` (`token`),
  KEY `password_reset_token_user_id_IDX` (`user_id`),
  KEY `password_reset_token_expires_at_IDX` (`expires_at`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='비밀번호 재설정 토큰';


/* Table : prompt_template */
CREATE TABLE `prompt_template` (
  `prompt_template_id` tinyint unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '템플릿 이름',
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '템플릿 설명',
  `system_prompt` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '시스템 프롬프트',
  `user_prompt` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '사용자 프롬프트 템플릿',
  `is_public` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '공용 템플릿 여부',
  `created_by_user_id` int unsigned DEFAULT NULL COMMENT '생성자 (개인 템플릿인 경우)',
  `category` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '카테고리 (문법, 회화, 작문 등)',
  `is_active` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '활성화 여부',
  `usage_count` int unsigned NOT NULL DEFAULT '0' COMMENT '사용 횟수',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성 시간',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정 시간',
  PRIMARY KEY (`prompt_template_id`),
  UNIQUE KEY `prompt_template_name_user_UIDX` (`name`,`created_by_user_id`),
  KEY `prompt_template_is_public_active_IDX` (`is_public`,`is_active`),
  KEY `prompt_template_category_IDX` (`category`)
) ENGINE=InnoDB AUTO_INCREMENT=37 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='프롬프트 템플릿';


/* Table : quiz_wrong_choice */
CREATE TABLE `quiz_wrong_choice` (
  `choice_id` int unsigned NOT NULL AUTO_INCREMENT,
  `vocabulary_id` int unsigned NOT NULL COMMENT '단어 ID (논리적 FK: vocabulary.vocabulary_id)',
  `meaning` varchar(200) COLLATE utf8mb4_general_ci NOT NULL COMMENT '오답 한국어 뜻',
  `classes` varchar(20) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '기타' COMMENT '품사',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`choice_id`),
  KEY `quiz_wrong_choice_vocabulary_id_IDX` (`vocabulary_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='퀴즈 오답 보기 캐시';


/* Table : sentence_answer */
CREATE TABLE `sentence_answer` (
  `answer_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `sentence_id` int unsigned NOT NULL COMMENT 'FK learning_sentence.sentence_id (논리적)',
  `eng_answer` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '영어 답변 예시',
  `kor_answer` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '한국어 답변 예시',
  `order_no` tinyint unsigned NOT NULL DEFAULT '1' COMMENT '답변 순서',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일',
  PRIMARY KEY (`answer_id`),
  KEY `sentence_answer_sentence_id_order_IDX` (`sentence_id`,`order_no`)
) ENGINE=InnoDB AUTO_INCREMENT=78 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='문장 답변 예시';


/* Table : user */
CREATE TABLE `user` (
  `user_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `username` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '유저명',
  `email` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '이메일',
  `password_hash` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '패스워드 해시',
  `is_active` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '활성화 여부',
  `is_admin` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '관리자 여부',
  `email_verified` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '이메일 인증 여부',
  `email_verified_at` datetime DEFAULT NULL COMMENT '이메일 인증 완료 시간',
  `last_login_at` datetime DEFAULT NULL COMMENT '마지막 로그인 시간',
  `deleted_at` datetime DEFAULT NULL COMMENT '삭제 시간',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `user_username_UIDX` (`username`),
  UNIQUE KEY `user_email_UIDX` (`email`),
  KEY `user_email_deleted_at_IDX` (`email`,`deleted_at`),
  KEY `idx_user_is_active_is_admin` (`is_active`,`is_admin`),
  KEY `idx_user_last_login_at` (`last_login_at`),
  KEY `idx_user_create_at` (`create_at`)
) ENGINE=InnoDB AUTO_INCREMENT=26 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자';


/* Table : user_chat_setting */
CREATE TABLE `user_chat_setting` (
  `setting_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `default_model_id` tinyint unsigned NOT NULL DEFAULT '2' COMMENT 'FK model_id (논리적) - 기본 모델',
  `temperature` float NOT NULL DEFAULT '0.9' COMMENT '모델 temperature (0.0-2.0)',
  `max_tokens` int unsigned NOT NULL DEFAULT '2000' COMMENT '최대 토큰 수',
  `top_p` float DEFAULT '1' COMMENT 'Top-p sampling',
  `frequency_penalty` float DEFAULT '0' COMMENT '빈도 패널티 (-2.0 ~ 2.0)',
  `presence_penalty` float DEFAULT '0' COMMENT '존재 패널티 (-2.0 ~ 2.0)',
  `default_prompt_template_id` tinyint unsigned DEFAULT NULL COMMENT 'FK prompt_template_id (논리적)',
  `system_prompt_override` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '시스템 프롬프트 오버라이드',
  `context_window_size` tinyint unsigned NOT NULL DEFAULT '10' COMMENT '대화 컨텍스트 윈도우 크기',
  `auto_save_conversation` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '대화 자동 저장',
  `show_token_usage` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '토큰 사용량 표시',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`setting_id`),
  UNIQUE KEY `user_chat_setting_user_id_UIDX` (`user_id`),
  KEY `user_chat_setting_model_id_IDX` (`default_model_id`)
) ENGINE=InnoDB AUTO_INCREMENT=24 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자 챗봇 설정';


/* Table : user_exam_setting */
CREATE TABLE `user_exam_setting` (
  `setting_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` tinyint unsigned NOT NULL COMMENT '사용자 ID (FK: user.user_id)',
  `tts_voice` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'alloy' COMMENT 'TTS 음성 (alloy, echo, fable, onyx, nova, shimmer)',
  `tts_speed` decimal(3,2) NOT NULL DEFAULT '0.90' COMMENT 'TTS 속도 (0.25~4.0)',
  `auto_play_question` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '문제 자동 재생 여부',
  `show_transcript` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '음성 텍스트 표시 여부',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일시',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일시',
  PRIMARY KEY (`setting_id`),
  UNIQUE KEY `user_exam_setting_user_id_UIDX` (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자별 시험 설정';


/* Table : user_learning_progress */
CREATE TABLE `user_learning_progress` (
  `progress_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `sentence_id` int unsigned NOT NULL COMMENT 'FK learning_sentence.sentence_id (논리적)',
  `cycle_count` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '복습 횟수',
  `correct_count` smallint unsigned NOT NULL DEFAULT '0' COMMENT '정답 횟수',
  `incorrect_count` smallint unsigned NOT NULL DEFAULT '0' COMMENT '오답 횟수',
  `last_reviewed_at` datetime DEFAULT NULL COMMENT '마지막 복습 시간',
  `next_review_date` date DEFAULT NULL COMMENT '다음 복습 예정일',
  `is_mastered` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '암기 완료 여부',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일',
  PRIMARY KEY (`progress_id`),
  UNIQUE KEY `user_learning_progress_user_sentence_UIDX` (`user_id`,`sentence_id`),
  KEY `user_learning_progress_user_next_review_IDX` (`user_id`,`next_review_date`),
  KEY `user_learning_progress_user_cycle_IDX` (`user_id`,`cycle_count`,`last_reviewed_at`),
  KEY `idx_ulp_user_mastered_review_date` (`user_id`,`is_mastered`,`next_review_date`)
) ENGINE=InnoDB AUTO_INCREMENT=97 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자별 문장 학습 진도';


/* Table : user_login_log */
CREATE TABLE `user_login_log` (
  `log_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `login_status` enum('success','failed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '로그인 상태',
  `ip_address` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'IP 주소 (IPv4/IPv6)',
  `user_agent` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'User Agent',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '로그인 시간',
  PRIMARY KEY (`log_id`,`create_at`),
  KEY `user_login_log_user_id_create_at_IDX` (`user_id`,`create_at` DESC),
  KEY `user_login_log_create_at_IDX` (`create_at` DESC),
  KEY `user_login_log_status_create_at_IDX` (`login_status`,`create_at` DESC)
) ENGINE=InnoDB AUTO_INCREMENT=178 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='로그인 이력'
/*!50100 PARTITION BY RANGE (((year(`create_at`) * 100) + month(`create_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION p202512 VALUES LESS THAN (202601) COMMENT = '2025년 12월' ENGINE = InnoDB,
 PARTITION p202601 VALUES LESS THAN (202602) COMMENT = '2026년 1월' ENGINE = InnoDB,
 PARTITION p202602 VALUES LESS THAN (202603) COMMENT = '2026년 2월' ENGINE = InnoDB,
 PARTITION p202603 VALUES LESS THAN (202604) COMMENT = '2026년 3월' ENGINE = InnoDB,
 PARTITION p202604 VALUES LESS THAN (202605) COMMENT = '2026년 4월' ENGINE = InnoDB,
 PARTITION p202605 VALUES LESS THAN (202606) COMMENT = '2026년 5월' ENGINE = InnoDB,
 PARTITION p202606 VALUES LESS THAN (202607) COMMENT = '2026년 6월' ENGINE = InnoDB,
 PARTITION p202607 VALUES LESS THAN (202608) COMMENT = '2026년 7월' ENGINE = InnoDB,
 PARTITION p202608 VALUES LESS THAN (202609) COMMENT = '2026년 8월' ENGINE = InnoDB,
 PARTITION p202609 VALUES LESS THAN (202610) COMMENT = '2026년 9월' ENGINE = InnoDB,
 PARTITION p202610 VALUES LESS THAN (202611) COMMENT = '2026년 10월' ENGINE = InnoDB,
 PARTITION p202611 VALUES LESS THAN (202612) COMMENT = '2026년 11월' ENGINE = InnoDB,
 PARTITION p202612 VALUES LESS THAN (202701) COMMENT = '2026년 12월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB) */;


/* Table : user_profile */
CREATE TABLE `user_profile` (
  `profile_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `display_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '표시 이름',
  `bio` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '자기소개',
  `instagram_url` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '인스타그램 링크',
  `linkedin_url` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '링크드인 링크',
  `avatar_url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '프로필 이미지 URL',
  `timezone` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Asia/Seoul' COMMENT '타임존',
  `language` char(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'ko-KR' COMMENT '언어 설정 (BCP 47)',
  `email_notification` char(1) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '이메일 알림',
  `push_notification` char(1) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '푸시 알림',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`profile_id`),
  UNIQUE KEY `user_profile_user_id_UIDX` (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=71 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자 프로필';


/* Table : user_push_subscription */
CREATE TABLE `user_push_subscription` (
  `subscription_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `platform` enum('web','android','ios') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'web' COMMENT '플랫폼 타입',
  `device_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '디바이스 이름 (사용자 지정)',
  `endpoint` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'Push 엔드포인트 (Web: subscription endpoint, App: FCM/APNs token)',
  `p256dh_key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '공개키 (Web Push 전용)',
  `auth_key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '인증키 (Web Push 전용)',
  `user_agent` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '브라우저/앱 정보',
  `is_active` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Y' COMMENT '활성화 여부',
  `notification_times` json DEFAULT NULL COMMENT '알림 시간 배열 ["09:00", "13:00", "21:00"]',
  `notification_format` enum('simple','detailed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'simple' COMMENT '알림 형식',
  `notification_content` json DEFAULT NULL COMMENT '알림 내용 설정',
  `last_sent_at` datetime DEFAULT NULL COMMENT '마지막 발송 시간',
  `consecutive_failures` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '연속 실패 횟수',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`subscription_id`),
  UNIQUE KEY `user_push_subscription_endpoint_UIDX` (`endpoint`),
  KEY `user_push_subscription_user_active_IDX` (`user_id`,`is_active`),
  KEY `user_push_subscription_user_platform_IDX` (`user_id`,`platform`),
  KEY `user_push_subscription_platform_IDX` (`platform`),
  KEY `idx_push_sub_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자 푸시 알림 구독 (웹/앱 통합)';


/* Table : user_security */
CREATE TABLE `user_security` (
  `user_id` int unsigned NOT NULL COMMENT 'PK, FK user_id (논리적)',
  `failed_login_attempts` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '로그인 실패 횟수',
  `locked_until` datetime DEFAULT NULL COMMENT '계정 잠금 해제 시간',
  `password_changed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '패스워드 변경일',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자 보안 정보';


/* Table : user_sentence_review_log */
CREATE TABLE `user_sentence_review_log` (
  `review_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT 'FK user_id (논리적)',
  `sentence_id` int unsigned NOT NULL COMMENT 'FK learning_sentence.sentence_id (논리적)',
  `review_result` enum('correct','incorrect','partial') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '복습 결과',
  `user_answer` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT '사용자 답변',
  `review_date` date NOT NULL COMMENT '복습 날짜',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '복습 시간',
  PRIMARY KEY (`review_id`,`review_date`),
  KEY `user_sentence_review_log_user_date_IDX` (`user_id`,`review_date` DESC),
  KEY `user_sentence_review_log_sentence_id_IDX` (`sentence_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='문장 복습 이력'
/*!50100 PARTITION BY RANGE (((year(`review_date`) * 100) + month(`review_date`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION p202512 VALUES LESS THAN (202601) COMMENT = '2025년 12월' ENGINE = InnoDB,
 PARTITION p202601 VALUES LESS THAN (202602) COMMENT = '2026년 1월' ENGINE = InnoDB,
 PARTITION p202602 VALUES LESS THAN (202603) COMMENT = '2026년 2월' ENGINE = InnoDB,
 PARTITION p202603 VALUES LESS THAN (202604) COMMENT = '2026년 3월' ENGINE = InnoDB,
 PARTITION p202604 VALUES LESS THAN (202605) COMMENT = '2026년 4월' ENGINE = InnoDB,
 PARTITION p202605 VALUES LESS THAN (202606) COMMENT = '2026년 5월' ENGINE = InnoDB,
 PARTITION p202606 VALUES LESS THAN (202607) COMMENT = '2026년 6월' ENGINE = InnoDB,
 PARTITION p202607 VALUES LESS THAN (202608) COMMENT = '2026년 7월' ENGINE = InnoDB,
 PARTITION p202608 VALUES LESS THAN (202609) COMMENT = '2026년 8월' ENGINE = InnoDB,
 PARTITION p202609 VALUES LESS THAN (202610) COMMENT = '2026년 9월' ENGINE = InnoDB,
 PARTITION p202610 VALUES LESS THAN (202611) COMMENT = '2026년 10월' ENGINE = InnoDB,
 PARTITION p202611 VALUES LESS THAN (202612) COMMENT = '2026년 11월' ENGINE = InnoDB,
 PARTITION p202612 VALUES LESS THAN (202701) COMMENT = '2026년 12월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB) */;


/* Table : vocabulary */
CREATE TABLE `vocabulary` (
  `vocabulary_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT '사용자 식별자 (논리적 FK: user.user_id)',
  `word` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '단어',
  `past_tense` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '과거형',
  `past_participle` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '과거분사',
  `rule` enum('규칙','불규칙','규칙없음') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '규칙없음' COMMENT '규칙성',
  `cycle_count` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '복습 사이클 (0-6)',
  `correct_count` int unsigned NOT NULL DEFAULT '0' COMMENT '정답 횟수',
  `incorrect_count` int unsigned NOT NULL DEFAULT '0' COMMENT '오답 횟수',
  `last_reviewed_at` datetime DEFAULT NULL COMMENT '마지막 복습 시간',
  `next_review_date` date DEFAULT NULL COMMENT '다음 복습 날짜',
  `is_mastered` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '암기 완료 여부 (Y/N)',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`vocabulary_id`),
  KEY `vocabulary_user_id_next_review_IDX` (`user_id`,`next_review_date`),
  KEY `vocabulary_user_id_mastered_IDX` (`user_id`,`is_mastered`),
  KEY `idx_vocabulary_user_word` (`user_id`,`word`),
  KEY `idx_vocabulary_user_create_at` (`user_id`,`create_at` DESC),
  FULLTEXT KEY `vocabulary_word_FTX` (`word`) /*!50100 WITH PARSER `ngram` */ 
) ENGINE=InnoDB AUTO_INCREMENT=137 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='사용자별 단어장';


/* Table : vocabulary_meaning */
CREATE TABLE `vocabulary_meaning` (
  `meaning_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `vocabulary_id` int unsigned NOT NULL COMMENT '단어 식별자 (논리적 FK: vocabulary.vocabulary_id)',
  `meaning` varchar(180) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '의미',
  `classes` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '품사',
  `example` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '예문 없음' COMMENT '예문',
  `parenthesis` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT '부연 설명',
  `order_no` tinyint unsigned NOT NULL DEFAULT '1' COMMENT '순서',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '등록일자',
  `update_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일자',
  PRIMARY KEY (`meaning_id`),
  KEY `idx_vocabulary_meaning_vocab_order` (`vocabulary_id`,`order_no`),
  FULLTEXT KEY `vocabulary_meaning_meaning_FTX` (`meaning`) /*!50100 WITH PARSER `ngram` */ 
) ENGINE=InnoDB AUTO_INCREMENT=226 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='단어 의미';


/* Table : vocabulary_quiz */
CREATE TABLE `vocabulary_quiz` (
  `quiz_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT '사용자 ID (논리적 FK: user.user_id)',
  `vocabulary_id` int unsigned NOT NULL COMMENT '출제 단어 ID (논리적 FK: vocabulary.vocabulary_id)',
  `quiz_type` enum('single','multiple') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'single' COMMENT '퀴즈 유형 (single: 단일정답, multiple: 복수정답)',
  `correct_answers` json NOT NULL COMMENT '정답 목록 (meaning 배열)',
  `user_answers` json DEFAULT NULL COMMENT '사용자 선택 목록',
  `is_correct` char(1) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'N' COMMENT '정답 여부',
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '풀이 시각',
  PRIMARY KEY (`quiz_id`),
  KEY `vocabulary_quiz_user_id_IDX` (`user_id`,`create_at`),
  KEY `vocabulary_quiz_vocabulary_id_IDX` (`vocabulary_id`),
  KEY `idx_vocabulary_quiz_user_correct_create` (`user_id`,`is_correct`,`create_at`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='단어 퀴즈 기록';


/* Table : vocabulary_review_log */
CREATE TABLE `vocabulary_review_log` (
  `log_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `user_id` int unsigned NOT NULL COMMENT '사용자 식별자 (논리적 FK: user.user_id)',
  `vocabulary_id` int unsigned NOT NULL COMMENT '단어 식별자 (논리적 FK: vocabulary.vocabulary_id)',
  `review_result` enum('correct','incorrect','partial') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '복습 결과',
  `cycle_count` tinyint unsigned NOT NULL COMMENT '복습 당시 사이클',
  `reviewed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '복습 시간',
  PRIMARY KEY (`log_id`,`reviewed_at`),
  KEY `vocabulary_review_log_user_id_IDX` (`user_id`),
  KEY `vocabulary_review_log_vocabulary_id_IDX` (`vocabulary_id`),
  KEY `vocabulary_review_log_reviewed_at_IDX` (`reviewed_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='단어 복습 이력 (월단위 파티셔닝)'
/*!50100 PARTITION BY RANGE (((year(`reviewed_at`) * 100) + month(`reviewed_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) COMMENT = '2025년 11월' ENGINE = InnoDB,
 PARTITION p202512 VALUES LESS THAN (202601) COMMENT = '2025년 12월' ENGINE = InnoDB,
 PARTITION p202601 VALUES LESS THAN (202602) COMMENT = '2026년 1월' ENGINE = InnoDB,
 PARTITION p202602 VALUES LESS THAN (202603) COMMENT = '2026년 2월' ENGINE = InnoDB,
 PARTITION p202603 VALUES LESS THAN (202604) COMMENT = '2026년 3월' ENGINE = InnoDB,
 PARTITION p202604 VALUES LESS THAN (202605) COMMENT = '2026년 4월' ENGINE = InnoDB,
 PARTITION p202605 VALUES LESS THAN (202606) COMMENT = '2026년 5월' ENGINE = InnoDB,
 PARTITION p202606 VALUES LESS THAN (202607) COMMENT = '2026년 6월' ENGINE = InnoDB,
 PARTITION p202607 VALUES LESS THAN (202608) COMMENT = '2026년 7월' ENGINE = InnoDB,
 PARTITION p202608 VALUES LESS THAN (202609) COMMENT = '2026년 8월' ENGINE = InnoDB,
 PARTITION p202609 VALUES LESS THAN (202610) COMMENT = '2026년 9월' ENGINE = InnoDB,
 PARTITION p202610 VALUES LESS THAN (202611) COMMENT = '2026년 10월' ENGINE = InnoDB,
 PARTITION p202611 VALUES LESS THAN (202612) COMMENT = '2026년 11월' ENGINE = InnoDB,
 PARTITION p202612 VALUES LESS THAN (202701) COMMENT = '2026년 12월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE COMMENT = '미래 데이터' ENGINE = InnoDB) */;


