sample-app 
=============

## Table List
- [ai_usage_log (AI 기능별 사용량 로그)](#ai_usage_log)
 - [chat_history (AI 챗봇 대화 이력)](#chat_history)
 - [community_comment (커뮤니티 댓글)](#community_comment)
 - [community_like (커뮤니티 좋아요)](#community_like)
 - [community_post (커뮤니티 게시글)](#community_post)
 - [conversation_practice_session (회화 연습 세션)](#conversation_practice_session)
 - [conversation_practice_turn (회화 연습 대화 턴)](#conversation_practice_turn)
 - [conversation_session (대화 세션 메타데이터)](#conversation_session)
 - [diary (영어 일기)](#diary)
 - [email_verification_token (이메일 인증 토큰)](#email_verification_token)
 - [exam_answer_history (시험 문제 답변 이력)](#exam_answer_history)
 - [exam_question (언어 시험 문제)](#exam_question)
 - [grammar (문법 노트)](#grammar)
 - [learning_sentence (학습 문장 (공용))](#learning_sentence)
 - [model (AI 모델 메타데이터)](#model)
 - [notification_log (알림 발송 이력 (웹/앱 통합))](#notification_log)
 - [password_reset_token (비밀번호 재설정 토큰)](#password_reset_token)
 - [prompt_template (프롬프트 템플릿)](#prompt_template)
 - [quiz_wrong_choice (퀴즈 오답 보기 캐시)](#quiz_wrong_choice)
 - [sentence_answer (문장 답변 예시)](#sentence_answer)
 - [user (사용자)](#user)
 - [user_chat_setting (사용자 챗봇 설정)](#user_chat_setting)
 - [user_exam_setting (사용자별 시험 설정)](#user_exam_setting)
 - [user_learning_progress (사용자별 문장 학습 진도)](#user_learning_progress)
 - [user_login_log (로그인 이력)](#user_login_log)
 - [user_profile (사용자 프로필)](#user_profile)
 - [user_push_subscription (사용자 푸시 알림 구독 (웹/앱 통합))](#user_push_subscription)
 - [user_security (사용자 보안 정보)](#user_security)
 - [user_sentence_review_log (문장 복습 이력)](#user_sentence_review_log)
 - [vocabulary (사용자별 단어장)](#vocabulary)
 - [vocabulary_meaning (단어 의미)](#vocabulary_meaning)
 - [vocabulary_quiz (단어 퀴즈 기록)](#vocabulary_quiz)
 - [vocabulary_review_log (단어 복습 이력 (월단위 파티셔닝))](#vocabulary_review_log)
 
## ai_usage_log
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci|AI 기능별 사용량 로그|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|log_id|int unsigned|NO||||PRI|auto_increment||
|user_id|int unsigned|NO||||MUL|||
|feature|varchar(50)|NO||utf8mb4|utf8mb4_0900_ai_ci|||youtube_summary, sentence_ai, exam_feedback, diary_ai 등|
|model_id|tinyint unsigned|YES|NULL||||||
|input_tokens|int unsigned|YES|NULL||||||
|output_tokens|int unsigned|YES|NULL||||||
|total_tokens|int unsigned|YES|NULL||||||
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED||

**Index**
- [Normal]ai_usage_log_user_id_IDX(user_id,create_at DESC)

 
## chat_history
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|AI 챗봇 대화 이력|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|chat_history_id|int unsigned|NO||||PRI|auto_increment|PK|
|conversation_id|char(18)|NO||utf8mb4|utf8mb4_general_ci|MUL||대화 세션 식별자|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|user_message|text|NO||utf8mb4|utf8mb4_general_ci|||사용자 메시지|
|bot_response|text|NO||utf8mb4|utf8mb4_general_ci|||봇 응답|
|input_tokens|int unsigned|YES|NULL|||||입력 토큰 수|
|output_tokens|int unsigned|YES|NULL|||||출력 토큰 수|
|total_tokens|int unsigned|YES|NULL|||||총 토큰 수|
|model_id|tinyint unsigned|YES|NULL|||||FK model_id (논리적)|
|create_at|datetime|NO|CURRENT_TIMESTAMP|||PRI|DEFAULT_GENERATED|생성 시간|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정 시간|

**Index**
- [Normal]chat_history_conversation_id_IDX(conversation_id)
- [Normal]chat_history_user_id_create_at_IDX(user_id,create_at DESC)

 
## community_comment
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|커뮤니티 댓글|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|comment_id|int unsigned|NO||||PRI|auto_increment|PK|
|post_id|int unsigned|NO||||MUL||게시글 ID (논리적 FK: community_post.post_id)|
|user_id|int unsigned|NO||||MUL||작성자 ID (논리적 FK: user.user_id)|
|body|text|NO||utf8mb4|utf8mb4_general_ci|||댓글 내용|
|is_active|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|||활성화 여부|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|작성일|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일|

**Index**
- [Normal]community_comment_user_id_IDX(user_id)
- [Normal]idx_community_comment_post_active_create(post_id,is_active,create_at)

 
## community_like
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|커뮤니티 좋아요|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|like_id|int unsigned|NO||||PRI|auto_increment|PK|
|post_id|int unsigned|NO||||MUL||게시글 ID (논리적 FK: community_post.post_id)|
|user_id|int unsigned|NO||||||사용자 ID (논리적 FK: user.user_id)|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|좋아요 시각|

**Index**
- [Unique]community_like_post_user_UIDX(post_id,user_id)

 
## community_post
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|커뮤니티 게시글|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|post_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||작성자 ID (논리적 FK: user.user_id)|
|category|enum('youtube','podcast','website','app','tip','other')|NO|'other'|utf8mb4|utf8mb4_general_ci|MUL||카테고리|
|title|varchar(200)|NO||utf8mb4|utf8mb4_general_ci|MUL||제목|
|body|text|NO||utf8mb4|utf8mb4_general_ci|||본문 (마크다운)|
|url|varchar(500)|YES|NULL|utf8mb4|utf8mb4_general_ci|||공유 링크 (YouTube/Podcast/사이트 URL)|
|tags|varchar(200)|YES|NULL|utf8mb4|utf8mb4_general_ci|||태그 (콤마 구분)|
|view_count|int unsigned|NO|0|||||조회수|
|like_count|int unsigned|NO|0|||||좋아요 수|
|comment_count|int unsigned|NO|0|||||댓글 수|
|is_active|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|||활성화 여부|
|create_at|datetime|NO|CURRENT_TIMESTAMP|||MUL|DEFAULT_GENERATED|작성일|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일|

**Index**
- [Normal]community_post_create_at_IDX(create_at)
- [Fulltext]community_post_search_FTX(title,body,tags)
- [Normal]idx_community_post_category_active_create(category,is_active,create_at DESC)
- [Normal]idx_community_post_user_active(user_id,is_active)

 
## conversation_practice_session
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|회화 연습 세션|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|session_id|char(18)|NO||utf8mb4|utf8mb4_general_ci|PRI||PK - 세션 ID (nanoid)|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|prompt_template_id|tinyint unsigned|NO||||MUL||FK prompt_template_id (논리적) - 사용자 프롬프트|
|model_id|tinyint unsigned|NO|3|||||FK model_id (논리적) - Realtime 모델|
|voice|varchar(20)|NO|'alloy'|utf8mb4|utf8mb4_general_ci|||음성 (alloy, echo, shimmer)|
|temperature|float|NO|0.8|||||온도 (0.6-1.2)|
|session_metadata|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||세션 메타데이터 (JSON) - 프롬프트 캐싱용|
|status|enum('active','completed','error','cancelled')|NO|'active'|utf8mb4|utf8mb4_general_ci|MUL||세션 상태|
|total_turns|int unsigned|NO|0|||||총 대화 턴 수|
|total_duration_seconds|int unsigned|NO|0|||||총 대화 시간 (초)|
|total_input_tokens|int unsigned|NO|0|||||총 입력 토큰|
|total_output_tokens|int unsigned|NO|0|||||총 출력 토큰|
|ai_feedback|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||AI 피드백 (JSON)|
|overall_score|tinyint unsigned|YES|NULL|||||총점 (0-100)|
|fluency_score|tinyint unsigned|YES|NULL|||||유창성 점수|
|grammar_score|tinyint unsigned|YES|NULL|||||문법 점수|
|vocabulary_score|tinyint unsigned|YES|NULL|||||어휘 점수|
|pronunciation_score|tinyint unsigned|YES|NULL|||||발음 점수|
|content_score|tinyint unsigned|YES|NULL|||||내용 점수|
|feedback_input_tokens|int unsigned|YES|NULL|||||피드백 생성 입력 토큰|
|feedback_output_tokens|int unsigned|YES|NULL|||||피드백 생성 출력 토큰|
|error_message|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||에러 메시지|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|세션 시작 시간|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정 시간|
|completed_at|datetime|YES|NULL|||||세션 종료 시간|

**Index**
- [Normal]conversation_practice_session_prompt_template_id_IDX(prompt_template_id)
- [Normal]conversation_practice_session_status_IDX(status)
- [Normal]conversation_practice_session_user_id_IDX(user_id,create_at DESC)

 
## conversation_practice_turn
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|회화 연습 대화 턴|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|turn_id|bigint unsigned|NO||||PRI|auto_increment|PK|
|session_id|char(18)|NO||utf8mb4|utf8mb4_general_ci|MUL||FK conversation_practice_session.session_id (논리적)|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|turn_number|int unsigned|NO||||||턴 번호 (1부터 시작)|
|user_audio_url|varchar(500)|YES|NULL|utf8mb4|utf8mb4_general_ci|||사용자 음성 URL (S3)|
|user_transcription|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||사용자 발화 텍스트 (Whisper)|
|ai_audio_url|varchar(500)|YES|NULL|utf8mb4|utf8mb4_general_ci|||AI 음성 URL (선택적 저장)|
|ai_transcription|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||AI 응답 텍스트|
|duration_seconds|int unsigned|YES|NULL|||||턴 지속 시간 (초)|
|input_tokens|int unsigned|YES|NULL|||||입력 토큰|
|output_tokens|int unsigned|YES|NULL|||||출력 토큰|
|timestamp_ms|bigint unsigned|NO||||||타임스탬프 (밀리초)|
|create_at|datetime|NO|CURRENT_TIMESTAMP|||PRI|DEFAULT_GENERATED|생성 시간|

**Index**
- [Normal]conversation_practice_turn_session_id_IDX(session_id,turn_number)
- [Normal]conversation_practice_turn_user_id_IDX(user_id,create_at DESC)

 
## conversation_session
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|대화 세션 메타데이터|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|conversation_id|char(18)|NO||utf8mb4|utf8mb4_general_ci|PRI||PK - 대화 세션 ID|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|title|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||대화 제목 (자동 생성 또는 사용자 지정)|
|status|enum('active','archived','deleted')|NO|'active'|utf8mb4|utf8mb4_general_ci|||대화 상태|
|message_count|int unsigned|NO|0|||||메시지 수|
|summary|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||대화 요약 (AI 생성)|
|category|varchar(50)|YES|NULL|utf8mb4|utf8mb4_general_ci|MUL||대화 카테고리 (영어학습, 문법질문 등)|
|tags|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||태그 (콤마 구분)|
|total_input_tokens|int unsigned|NO|0|||||총 입력 토큰|
|total_output_tokens|int unsigned|NO|0|||||총 출력 토큰|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성 시간|
|last_message_at|datetime|NO||||||마지막 메시지 시간|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정 시간|

**Index**
- [Normal]conversation_session_category_IDX(category)
- [Normal]conversation_session_user_id_last_msg_IDX(user_id,last_message_at DESC)
- [Normal]conversation_session_user_id_status_IDX(user_id,status)
- [Normal]idx_conversation_session_user_status_lastmsg(user_id,status,last_message_at DESC)

 
## diary
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|영어 일기|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|diary_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|date|date|NO||||MUL||날짜|
|body|longtext|NO||utf8mb4|utf8mb4_general_ci|||본문|
|feedback|longtext|YES|NULL|utf8mb4|utf8mb4_general_ci|||AI 피드백|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Normal]diary_date_IDX(date DESC)
- [Unique]diary_user_id_date_UIDX(user_id,date DESC)

 
## email_verification_token
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|이메일 인증 토큰|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|token_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|token|char(64)|NO||utf8mb4|utf8mb4_general_ci|UNI||인증 토큰|
|expires_at|datetime|NO||||MUL||만료 시간|
|verified_at|datetime|YES|NULL|||||인증 완료 시간|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성일자|

**Index**
- [Normal]email_verification_token_expires_at_IDX(expires_at)
- [Unique]email_verification_token_token_UIDX(token)
- [Normal]email_verification_token_user_id_IDX(user_id)

 
## exam_answer_history
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|시험 문제 답변 이력|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|answer_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|question_id|int unsigned|NO||||MUL||FK exam_question.question_id (논리적)|
|user_answer_text|text|NO||utf8mb4|utf8mb4_general_ci|||사용자 답변 (텍스트)|
|audio_url|varchar(500)|YES|NULL|utf8mb4|utf8mb4_general_ci|||음성 파일 URL (S3)|
|transcription|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||Whisper 변환 텍스트|
|ai_feedback|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||AI 피드백|
|score|tinyint unsigned|YES|NULL|||||점수 (0-100)|
|fluency_score|tinyint unsigned|YES|NULL|||||유창성 점수|
|grammar_score|tinyint unsigned|YES|NULL|||||문법 점수|
|vocabulary_score|tinyint unsigned|YES|NULL|||||어휘 점수|
|pronunciation_score|tinyint unsigned|YES|NULL|||||발음 점수|
|content_score|tinyint unsigned|YES|NULL|||||내용 점수|
|duration_seconds|int unsigned|YES|NULL|||||답변 시간 (초)|
|model_id|tinyint unsigned|YES|NULL|||||FK model_id (논리적)|
|input_tokens|int unsigned|YES|NULL|||||입력 토큰 수|
|output_tokens|int unsigned|YES|NULL|||||출력 토큰 수|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|답변 시간|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정 시간|

**Index**
- [Normal]exam_answer_history_question_id_IDX(question_id)
- [Normal]exam_answer_history_user_create_IDX(user_id,create_at DESC)
- [Normal]idx_exam_answer_user_question(user_id,question_id)

 
## exam_question
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|언어 시험 문제|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|question_id|int unsigned|NO||||PRI|auto_increment|PK|
|exam_type|enum('OPIC','TOEIC_SPEAKING','TOEFL','IELTS','TEPS')|NO|'OPIC'|utf8mb4|utf8mb4_general_ci|MUL||시험 유형|
|section|varchar(50)|NO||utf8mb4|utf8mb4_general_ci|||섹션|
|survey|varchar(100)|YES|NULL|utf8mb4|utf8mb4_general_ci|||서베이/주제|
|question|text|NO||utf8mb4|utf8mb4_general_ci|||질문|
|is_active|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|||활성화 여부|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|등록일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Normal]idx_exam_question_type_active_section_survey(exam_type,is_active,section,survey)

 
## grammar
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|문법 노트|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|grammar_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|title|varchar(100)|NO||utf8mb4|utf8mb4_general_ci|MUL||타이틀|
|body|longtext|YES|NULL|utf8mb4|utf8mb4_general_ci|||내용 정리|
|url|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||강의 링크 URL|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|등록일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Fulltext]grammar_title_FTX(title)
- [Normal]grammar_user_id_create_at_IDX(user_id,create_at DESC)

 
## learning_sentence
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|학습 문장 (공용)|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|sentence_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||user_id|
|eng_sentence|text|NO||utf8mb4|utf8mb4_general_ci|MUL||영어 문장|
|kor_sentence|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||한국어 의미|
|note|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||추가 설명|
|category|varchar(50)|YES|NULL|utf8mb4|utf8mb4_general_ci|MUL||카테고리 (구동사, 관용구, 일상표현 등)|
|tags|varchar(100)|YES|NULL|utf8mb4|utf8mb4_general_ci|||태그 (콤마 구분)|
|is_active|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|||활성화 여부|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|등록일|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일|

**Index**
- [Normal]idx_learning_sentence_user_active_category(user_id,is_active,category)
- [Normal]learning_sentence_category_IDX(category)
- [Fulltext]learning_sentence_content_FTX(eng_sentence,kor_sentence,note,tags)

 
## model
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|AI 모델 메타데이터|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|model_id|tinyint unsigned|NO||||PRI|auto_increment|PK|
|vendor|varchar(20)|NO||utf8mb4|utf8mb4_general_ci|MUL||제공사 (OpenAI, Anthropic, Google 등)|
|region|varchar(20)|YES|'ap-northeast-2'|utf8mb4|utf8mb4_general_ci|||AWS 리전|
|ai_model|varchar(50)|NO||utf8mb4|utf8mb4_general_ci|UNI||AI 모델명|
|is_active|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|MUL||활성화 여부|
|is_default|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||기본 모델 여부|
|description|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||모델 설명|
|max_context_tokens|int unsigned|YES|NULL|||||최대 컨텍스트 토큰|
|supports_function_calling|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||함수 호출 지원|
|supports_vision|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||비전 지원|
|input_price|decimal(10,3)|NO|0.000|||||Input 가격 (USD per 1M tokens)|
|output_price|decimal(10,3)|NO|0.000|||||Output 가격 (USD per 1M tokens)|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|등록일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Unique]model_ai_model_UIDX(ai_model)
- [Normal]model_is_active_is_default_IDX(is_active,is_default)
- [Normal]model_vendor_IDX(vendor)

 
## notification_log
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|알림 발송 이력 (웹/앱 통합)|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|log_id|bigint unsigned|NO||||PRI|auto_increment|PK|
|subscription_id|int unsigned|NO||||MUL||FK user_push_subscription.subscription_id (논리적)|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|platform|enum('web','android','ios')|NO||utf8mb4|utf8mb4_general_ci|MUL||플랫폼 타입|
|sent_at|datetime|NO|CURRENT_TIMESTAMP|||PRI|DEFAULT_GENERATED|발송 시간|
|status|enum('success','failed','retry')|NO||utf8mb4|utf8mb4_general_ci|MUL||발송 상태|
|error_message|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||에러 메시지|
|message_title|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||알림 제목|
|message_body|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||알림 본문|
|retry_count|tinyint unsigned|NO|0|||||재시도 횟수|
|clicked_at|datetime|YES|NULL|||||알림 클릭 시간|

**Index**
- [Normal]notification_log_platform_IDX(platform)
- [Normal]notification_log_status_IDX(status)
- [Normal]notification_log_subscription_id_IDX(subscription_id)
- [Normal]notification_log_user_sent_IDX(user_id,sent_at DESC)

 
## password_reset_token
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|비밀번호 재설정 토큰|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|token_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|token|char(64)|NO||utf8mb4|utf8mb4_general_ci|UNI||재설정 토큰|
|expires_at|datetime|NO||||MUL||만료 시간|
|used_at|datetime|YES|NULL|||||사용 완료 시간|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성일자|

**Index**
- [Normal]password_reset_token_expires_at_IDX(expires_at)
- [Unique]password_reset_token_token_UIDX(token)
- [Normal]password_reset_token_user_id_IDX(user_id)

 
## prompt_template
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|프롬프트 템플릿|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|prompt_template_id|tinyint unsigned|NO||||PRI|auto_increment|PK|
|name|varchar(100)|NO||utf8mb4|utf8mb4_general_ci|MUL||템플릿 이름|
|description|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||템플릿 설명|
|system_prompt|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||시스템 프롬프트|
|user_prompt|text|NO||utf8mb4|utf8mb4_general_ci|||사용자 프롬프트 템플릿|
|is_public|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|MUL||공용 템플릿 여부|
|created_by_user_id|int unsigned|YES|NULL|||||생성자 (개인 템플릿인 경우)|
|category|varchar(50)|YES|NULL|utf8mb4|utf8mb4_general_ci|MUL||카테고리 (문법, 회화, 작문 등)|
|is_active|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|||활성화 여부|
|usage_count|int unsigned|NO|0|||||사용 횟수|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성 시간|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정 시간|

**Index**
- [Normal]prompt_template_category_IDX(category)
- [Normal]prompt_template_is_public_active_IDX(is_public,is_active)
- [Unique]prompt_template_name_user_UIDX(name,created_by_user_id)

 
## quiz_wrong_choice
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|퀴즈 오답 보기 캐시|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|choice_id|int unsigned|NO||||PRI|auto_increment||
|vocabulary_id|int unsigned|NO||||MUL||단어 ID (논리적 FK: vocabulary.vocabulary_id)|
|meaning|varchar(200)|NO||utf8mb4|utf8mb4_general_ci|||오답 한국어 뜻|
|classes|varchar(20)|NO|'기타'|utf8mb4|utf8mb4_general_ci|||품사|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED||

**Index**
- [Normal]quiz_wrong_choice_vocabulary_id_IDX(vocabulary_id)

 
## sentence_answer
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|문장 답변 예시|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|answer_id|int unsigned|NO||||PRI|auto_increment|PK|
|sentence_id|int unsigned|NO||||MUL||FK learning_sentence.sentence_id (논리적)|
|eng_answer|text|NO||utf8mb4|utf8mb4_general_ci|||영어 답변 예시|
|kor_answer|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||한국어 답변 예시|
|order_no|tinyint unsigned|NO|1|||||답변 순서|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|등록일|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일|

**Index**
- [Normal]sentence_answer_sentence_id_order_IDX(sentence_id,order_no)

 
## user
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|사용자|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|user_id|int unsigned|NO||||PRI|auto_increment|PK|
|username|varchar(20)|NO||utf8mb4|utf8mb4_general_ci|UNI||유저명|
|email|varchar(100)|NO||utf8mb4|utf8mb4_general_ci|UNI||이메일|
|password_hash|varchar(255)|NO||utf8mb4|utf8mb4_general_ci|||패스워드 해시|
|is_active|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|MUL||활성화 여부|
|is_admin|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||관리자 여부|
|email_verified|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||이메일 인증 여부|
|email_verified_at|datetime|YES|NULL|||||이메일 인증 완료 시간|
|last_login_at|datetime|YES|NULL|||MUL||마지막 로그인 시간|
|deleted_at|datetime|YES|NULL|||||삭제 시간|
|create_at|datetime|NO|CURRENT_TIMESTAMP|||MUL|DEFAULT_GENERATED|등록일|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Normal]idx_user_create_at(create_at)
- [Normal]idx_user_is_active_is_admin(is_active,is_admin)
- [Normal]idx_user_last_login_at(last_login_at)
- [Normal]user_email_deleted_at_IDX(email,deleted_at)
- [Unique]user_email_UIDX(email)
- [Unique]user_username_UIDX(username)

 
## user_chat_setting
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|사용자 챗봇 설정|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|setting_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||UNI||FK user_id (논리적)|
|default_model_id|tinyint unsigned|NO|2|||MUL||FK model_id (논리적) - 기본 모델|
|temperature|float|NO|0.9|||||모델 temperature (0.0-2.0)|
|max_tokens|int unsigned|NO|2000|||||최대 토큰 수|
|top_p|float|YES|1|||||Top-p sampling|
|frequency_penalty|float|YES|0|||||빈도 패널티 (-2.0 ~ 2.0)|
|presence_penalty|float|YES|0|||||존재 패널티 (-2.0 ~ 2.0)|
|default_prompt_template_id|tinyint unsigned|YES|NULL|||||FK prompt_template_id (논리적)|
|system_prompt_override|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||시스템 프롬프트 오버라이드|
|context_window_size|tinyint unsigned|NO|10|||||대화 컨텍스트 윈도우 크기|
|auto_save_conversation|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|||대화 자동 저장|
|show_token_usage|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||토큰 사용량 표시|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Normal]user_chat_setting_model_id_IDX(default_model_id)
- [Unique]user_chat_setting_user_id_UIDX(user_id)

 
## user_exam_setting
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|사용자별 시험 설정|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|setting_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|tinyint unsigned|NO||||UNI||사용자 ID (FK: user.user_id)|
|tts_voice|varchar(20)|NO|'alloy'|utf8mb4|utf8mb4_general_ci|||TTS 음성 (alloy, echo, fable, onyx, nova, shimmer)|
|tts_speed|decimal(3,2)|NO|0.90|||||TTS 속도 (0.25~4.0)|
|auto_play_question|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||문제 자동 재생 여부|
|show_transcript|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|||음성 텍스트 표시 여부|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성일시|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일시|

**Index**
- [Unique]user_exam_setting_user_id_UIDX(user_id)

 
## user_learning_progress
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|사용자별 문장 학습 진도|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|progress_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|sentence_id|int unsigned|NO||||||FK learning_sentence.sentence_id (논리적)|
|cycle_count|tinyint unsigned|NO|0|||||복습 횟수|
|correct_count|smallint unsigned|NO|0|||||정답 횟수|
|incorrect_count|smallint unsigned|NO|0|||||오답 횟수|
|last_reviewed_at|datetime|YES|NULL|||||마지막 복습 시간|
|next_review_date|date|YES|NULL|||||다음 복습 예정일|
|is_mastered|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||암기 완료 여부|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|등록일|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일|

**Index**
- [Normal]idx_ulp_user_mastered_review_date(user_id,is_mastered,next_review_date)
- [Normal]user_learning_progress_user_cycle_IDX(user_id,cycle_count,last_reviewed_at)
- [Normal]user_learning_progress_user_next_review_IDX(user_id,next_review_date)
- [Unique]user_learning_progress_user_sentence_UIDX(user_id,sentence_id)

 
## user_login_log
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|로그인 이력|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|log_id|bigint unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|login_status|enum('success','failed')|NO||utf8mb4|utf8mb4_general_ci|MUL||로그인 상태|
|ip_address|varchar(45)|NO||utf8mb4|utf8mb4_general_ci|||IP 주소 (IPv4/IPv6)|
|user_agent|varchar(512)|YES|NULL|utf8mb4|utf8mb4_general_ci|||User Agent|
|create_at|datetime|NO|CURRENT_TIMESTAMP|||PRI|DEFAULT_GENERATED|로그인 시간|

**Index**
- [Normal]user_login_log_create_at_IDX(create_at DESC)
- [Normal]user_login_log_status_create_at_IDX(login_status,create_at DESC)
- [Normal]user_login_log_user_id_create_at_IDX(user_id,create_at DESC)

 
## user_profile
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|사용자 프로필|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|profile_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||UNI||FK user_id (논리적)|
|display_name|varchar(50)|YES|NULL|utf8mb4|utf8mb4_general_ci|||표시 이름|
|bio|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||자기소개|
|instagram_url|varchar(200)|YES|NULL|utf8mb4|utf8mb4_general_ci|||인스타그램 링크|
|linkedin_url|varchar(200)|YES|NULL|utf8mb4|utf8mb4_general_ci|||링크드인 링크|
|avatar_url|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||프로필 이미지 URL|
|timezone|varchar(50)|NO|'Asia/Seoul'|utf8mb4|utf8mb4_general_ci|||타임존|
|language|char(5)|NO|'ko-KR'|utf8mb4|utf8mb4_general_ci|||언어 설정 (BCP 47)|
|email_notification|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||이메일 알림|
|push_notification|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||푸시 알림|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Unique]user_profile_user_id_UIDX(user_id)

 
## user_push_subscription
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|사용자 푸시 알림 구독 (웹/앱 통합)|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|subscription_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|platform|enum('web','android','ios')|NO|'web'|utf8mb4|utf8mb4_general_ci|MUL||플랫폼 타입|
|device_name|varchar(100)|YES|NULL|utf8mb4|utf8mb4_general_ci|||디바이스 이름 (사용자 지정)|
|endpoint|varchar(512)|NO||utf8mb4|utf8mb4_general_ci|UNI||Push 엔드포인트 (Web: subscription endpoint, App: FCM/APNs token)|
|p256dh_key|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||공개키 (Web Push 전용)|
|auth_key|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||인증키 (Web Push 전용)|
|user_agent|varchar(512)|YES|NULL|utf8mb4|utf8mb4_general_ci|||브라우저/앱 정보|
|is_active|char(1)|NO|'Y'|utf8mb4|utf8mb4_general_ci|MUL||활성화 여부|
|notification_times|json|YES|NULL|||||알림 시간 배열 ["09:00", "13:00", "21:00"]|
|notification_format|enum('simple','detailed')|NO|'simple'|utf8mb4|utf8mb4_general_ci|||알림 형식|
|notification_content|json|YES|NULL|||||알림 내용 설정|
|last_sent_at|datetime|YES|NULL|||||마지막 발송 시간|
|consecutive_failures|tinyint unsigned|NO|0|||||연속 실패 횟수|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Normal]idx_push_sub_active(is_active)
- [Unique]user_push_subscription_endpoint_UIDX(endpoint)
- [Normal]user_push_subscription_platform_IDX(platform)
- [Normal]user_push_subscription_user_active_IDX(user_id,is_active)
- [Normal]user_push_subscription_user_platform_IDX(user_id,platform)

 
## user_security
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|사용자 보안 정보|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|user_id|int unsigned|NO||||PRI||PK, FK user_id (논리적)|
|failed_login_attempts|tinyint unsigned|NO|0|||||로그인 실패 횟수|
|locked_until|datetime|YES|NULL|||||계정 잠금 해제 시간|
|password_changed_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|패스워드 변경일|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|생성일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

 
## user_sentence_review_log
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|문장 복습 이력|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|review_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||FK user_id (논리적)|
|sentence_id|int unsigned|NO||||MUL||FK learning_sentence.sentence_id (논리적)|
|review_result|enum('correct','incorrect','partial')|NO||utf8mb4|utf8mb4_general_ci|||복습 결과|
|user_answer|text|YES|NULL|utf8mb4|utf8mb4_general_ci|||사용자 답변|
|review_date|date|NO||||PRI||복습 날짜|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|복습 시간|

**Index**
- [Normal]user_sentence_review_log_sentence_id_IDX(sentence_id)
- [Normal]user_sentence_review_log_user_date_IDX(user_id,review_date DESC)

 
## vocabulary
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|사용자별 단어장|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|vocabulary_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||사용자 식별자 (논리적 FK: user.user_id)|
|word|varchar(100)|NO||utf8mb4|utf8mb4_general_ci|MUL||단어|
|past_tense|varchar(100)|YES|NULL|utf8mb4|utf8mb4_general_ci|||과거형|
|past_participle|varchar(100)|YES|NULL|utf8mb4|utf8mb4_general_ci|||과거분사|
|rule|enum('규칙','불규칙','규칙없음')|NO|'규칙없음'|utf8mb4|utf8mb4_general_ci|||규칙성|
|cycle_count|tinyint unsigned|NO|0|||||복습 사이클 (0-6)|
|correct_count|int unsigned|NO|0|||||정답 횟수|
|incorrect_count|int unsigned|NO|0|||||오답 횟수|
|last_reviewed_at|datetime|YES|NULL|||||마지막 복습 시간|
|next_review_date|date|YES|NULL|||||다음 복습 날짜|
|is_mastered|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||암기 완료 여부 (Y/N)|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|등록일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Normal]idx_vocabulary_user_create_at(user_id,create_at DESC)
- [Normal]idx_vocabulary_user_word(user_id,word)
- [Normal]vocabulary_user_id_mastered_IDX(user_id,is_mastered)
- [Normal]vocabulary_user_id_next_review_IDX(user_id,next_review_date)
- [Fulltext]vocabulary_word_FTX(word)

 
## vocabulary_meaning
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|단어 의미|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|meaning_id|int unsigned|NO||||PRI|auto_increment|PK|
|vocabulary_id|int unsigned|NO||||MUL||단어 식별자 (논리적 FK: vocabulary.vocabulary_id)|
|meaning|varchar(180)|NO||utf8mb4|utf8mb4_general_ci|MUL||의미|
|classes|varchar(20)|NO||utf8mb4|utf8mb4_general_ci|||품사|
|example|varchar(255)|NO|'예문 없음'|utf8mb4|utf8mb4_general_ci|||예문|
|parenthesis|varchar(255)|YES|NULL|utf8mb4|utf8mb4_general_ci|||부연 설명|
|order_no|tinyint unsigned|NO|1|||||순서|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|등록일자|
|update_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP|수정일자|

**Index**
- [Normal]idx_vocabulary_meaning_vocab_order(vocabulary_id,order_no)
- [Fulltext]vocabulary_meaning_meaning_FTX(meaning)

 
## vocabulary_quiz
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|단어 퀴즈 기록|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|quiz_id|int unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||사용자 ID (논리적 FK: user.user_id)|
|vocabulary_id|int unsigned|NO||||MUL||출제 단어 ID (논리적 FK: vocabulary.vocabulary_id)|
|quiz_type|enum('single','multiple')|NO|'single'|utf8mb4|utf8mb4_general_ci|||퀴즈 유형 (single: 단일정답, multiple: 복수정답)|
|correct_answers|json|NO||||||정답 목록 (meaning 배열)|
|user_answers|json|YES|NULL|||||사용자 선택 목록|
|is_correct|char(1)|NO|'N'|utf8mb4|utf8mb4_general_ci|||정답 여부|
|create_at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED|풀이 시각|

**Index**
- [Normal]idx_vocabulary_quiz_user_correct_create(user_id,is_correct,create_at)
- [Normal]vocabulary_quiz_user_id_IDX(user_id,create_at)
- [Normal]vocabulary_quiz_vocabulary_id_IDX(vocabulary_id)

 
## vocabulary_review_log
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_general_ci|단어 복습 이력 (월단위 파티셔닝)|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|log_id|bigint unsigned|NO||||PRI|auto_increment|PK|
|user_id|int unsigned|NO||||MUL||사용자 식별자 (논리적 FK: user.user_id)|
|vocabulary_id|int unsigned|NO||||MUL||단어 식별자 (논리적 FK: vocabulary.vocabulary_id)|
|review_result|enum('correct','incorrect','partial')|NO||utf8mb4|utf8mb4_general_ci|||복습 결과|
|cycle_count|tinyint unsigned|NO||||||복습 당시 사이클|
|reviewed_at|datetime|NO|CURRENT_TIMESTAMP|||PRI|DEFAULT_GENERATED|복습 시간|

**Index**
- [Normal]vocabulary_review_log_reviewed_at_IDX(reviewed_at DESC)
- [Normal]vocabulary_review_log_user_id_IDX(user_id)
- [Normal]vocabulary_review_log_vocabulary_id_IDX(vocabulary_id)

 
