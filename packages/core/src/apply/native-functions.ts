// MySQL 8.0/8.4 의 내장 함수 이름 (리뷰 10회차 R10-1). 따옴표·스키마 없이 쓴 '이름(' 이 이름이 같은 저장 함수가 있어도 내장 함수를 부르는지 가른다 (stored-call.ts).
// 만든 방법 (8.0.46·8.4.11 실측): mysql.help_topic 에서 함수 도움말 분류(문자열·숫자·날짜·집계·윈도·흐름 제어·형 변환·비교·JSON·공간·XML·정보·암호·잠금·GTID·
// Performance Schema 함수 …)의 이름과 매뉴얼의 별칭(SHA, ST_ 별칭)을 모아, 이름마다 그 이름의 저장 함수를 만든 뒤 '이름(…)' 을 바로 붙인 꼴과 공백·탭·줄바꿈·CR·VT·FF·NBSP·
// 주석(/**/·/* x */·-- x·# x·/*!50000 */)을 끼운 꼴로 기본 SQL_MODE 와 IGNORE_SPACE 에서 불러 저장 함수가 돌았는지 봤다. 두 버전에서 같게 내장 함수인 이름만 둔다.
// 연산자(AND·IN·LIKE·REGEXP·EXISTS …), 시스템 뷰 전용 내부 함수(INTERNAL_*·CAN_ACCESS_*·GET_DD_* — 사용자가 부르면 3554), 커뮤니티판에 없는 Enterprise Encryption 함수
// (저장 함수가 돈다), 8.4 에서 없어진 WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS, 8.0 에서 없어진 이름(PASSWORD·ENCODE·GEOMFROMTEXT …)은 뺐다. 빠진 내장 함수 이름은 저장 함수 호출로
// 세어 보수적이다 (그 값을 뒤에서 읽는 문장만 거부된다)

// 이름과 '(' 사이에 공백·주석을 끼워도 내장 함수인 이름 (소문자). 키워드 문법 함수(IF·CHAR·INSERT·REPLACE·VALUES …)와 네이티브 함수 표의 이름(CONCAT·JSON_LENGTH …)이다
export const NATIVE_FUNCTIONS: ReadonlySet<string> = new Set([
  'abs', 'acos', 'addtime', 'aes_decrypt', 'aes_encrypt', 'any_value', 'ascii', 'asin', 'atan', 'atan2', 'avg', 'benchmark', 'bin', 'bin_to_uuid', 'bit_count',
  'bit_length', 'ceil', 'ceiling', 'char', 'char_length', 'character_length', 'charset', 'coalesce', 'coercibility', 'collation', 'compress', 'concat', 'concat_ws',
  'connection_id', 'conv', 'convert', 'convert_tz', 'cos', 'cot', 'crc32', 'cume_dist', 'current_date', 'current_role', 'current_time', 'current_timestamp',
  'current_user', 'database', 'date', 'date_format', 'datediff', 'day', 'dayname', 'dayofmonth', 'dayofweek', 'dayofyear', 'default', 'degrees', 'dense_rank', 'elt',
  'exp', 'export_set', 'extractvalue', 'field', 'find_in_set', 'first_value', 'floor', 'format', 'format_bytes', 'format_pico_time', 'found_rows', 'from_base64',
  'from_days', 'from_unixtime', 'geomcollection', 'geometrycollection', 'get_format', 'get_lock', 'greatest', 'grouping', 'gtid_subset', 'gtid_subtract', 'hex', 'hour',
  'icu_version', 'if', 'ifnull', 'inet6_aton', 'inet6_ntoa', 'inet_aton', 'inet_ntoa', 'insert', 'instr', 'interval', 'is_free_lock', 'is_ipv4', 'is_ipv4_compat',
  'is_ipv4_mapped', 'is_ipv6', 'is_used_lock', 'is_uuid', 'isnull', 'json_array', 'json_array_append', 'json_array_insert', 'json_contains', 'json_contains_path',
  'json_depth', 'json_extract', 'json_insert', 'json_keys', 'json_length', 'json_merge', 'json_merge_patch', 'json_merge_preserve', 'json_object', 'json_overlaps',
  'json_pretty', 'json_quote', 'json_remove', 'json_replace', 'json_schema_valid', 'json_schema_validation_report', 'json_search', 'json_set', 'json_storage_free',
  'json_storage_size', 'json_table', 'json_type', 'json_unquote', 'json_valid', 'json_value', 'lag', 'last_day', 'last_insert_id', 'last_value', 'lcase', 'lead',
  'least', 'left', 'length', 'linestring', 'ln', 'load_file', 'localtime', 'localtimestamp', 'locate', 'log', 'log10', 'log2', 'lower', 'lpad', 'ltrim', 'make_set',
  'makedate', 'maketime', 'master_pos_wait', 'mbrcontains', 'mbrcoveredby', 'mbrcovers', 'mbrdisjoint', 'mbrequals', 'mbrintersects', 'mbroverlaps', 'mbrtouches',
  'mbrwithin', 'md5', 'microsecond', 'minute', 'mod', 'month', 'monthname', 'multilinestring', 'multipoint', 'multipolygon', 'name_const', 'nth_value', 'ntile',
  'nullif', 'oct', 'octet_length', 'ord', 'percent_rank', 'period_add', 'period_diff', 'pi', 'point', 'polygon', 'pow', 'power', 'ps_current_thread_id', 'ps_thread_id',
  'quarter', 'quote', 'radians', 'rand', 'random_bytes', 'rank', 'regexp_instr', 'regexp_like', 'regexp_replace', 'regexp_substr', 'release_all_locks', 'release_lock',
  'repeat', 'replace', 'reverse', 'right', 'roles_graphml', 'round', 'row_count', 'row_number', 'rpad', 'rtrim', 'schema', 'sec_to_time', 'second', 'sha', 'sha1',
  'sha2', 'sign', 'sin', 'sleep', 'soundex', 'source_pos_wait', 'space', 'sqrt', 'st_area', 'st_asbinary', 'st_asgeojson', 'st_astext', 'st_aswkb', 'st_aswkt',
  'st_buffer', 'st_buffer_strategy', 'st_centroid', 'st_contains', 'st_convexhull', 'st_crosses', 'st_difference', 'st_dimension', 'st_disjoint', 'st_distance',
  'st_distance_sphere', 'st_endpoint', 'st_envelope', 'st_equals', 'st_exteriorring', 'st_frechetdistance', 'st_geohash', 'st_geomcollfromtext', 'st_geomcollfromtxt',
  'st_geomcollfromwkb', 'st_geometrycollectionfromtext', 'st_geometrycollectionfromwkb', 'st_geometryfromtext', 'st_geometryfromwkb', 'st_geometryn', 'st_geometrytype',
  'st_geomfromgeojson', 'st_geomfromtext', 'st_geomfromwkb', 'st_hausdorffdistance', 'st_interiorringn', 'st_intersection', 'st_intersects', 'st_isclosed', 'st_isempty',
  'st_issimple', 'st_isvalid', 'st_latfromgeohash', 'st_latitude', 'st_length', 'st_linefromtext', 'st_linefromwkb', 'st_lineinterpolatepoint',
  'st_lineinterpolatepoints', 'st_linestringfromtext', 'st_linestringfromwkb', 'st_longfromgeohash', 'st_longitude', 'st_makeenvelope', 'st_mlinefromtext',
  'st_mlinefromwkb', 'st_mpointfromtext', 'st_mpointfromwkb', 'st_mpolyfromtext', 'st_mpolyfromwkb', 'st_multilinestringfromtext', 'st_multilinestringfromwkb',
  'st_multipointfromtext', 'st_multipointfromwkb', 'st_multipolygonfromtext', 'st_multipolygonfromwkb', 'st_numgeometries', 'st_numinteriorring', 'st_numinteriorrings',
  'st_numpoints', 'st_overlaps', 'st_pointatdistance', 'st_pointfromgeohash', 'st_pointfromtext', 'st_pointfromwkb', 'st_pointn', 'st_polyfromtext', 'st_polyfromwkb',
  'st_polygonfromtext', 'st_polygonfromwkb', 'st_simplify', 'st_srid', 'st_startpoint', 'st_swapxy', 'st_symdifference', 'st_touches', 'st_transform', 'st_union',
  'st_validate', 'st_within', 'st_x', 'st_y', 'statement_digest', 'statement_digest_text', 'str_to_date', 'strcmp', 'substring_index', 'subtime', 'tan', 'time',
  'time_format', 'time_to_sec', 'timediff', 'timestamp', 'timestampadd', 'timestampdiff', 'to_base64', 'to_days', 'to_seconds', 'truncate', 'ucase', 'uncompress',
  'uncompressed_length', 'unhex', 'unix_timestamp', 'updatexml', 'upper', 'user', 'utc_date', 'utc_time', 'utc_timestamp', 'uuid', 'uuid_short', 'uuid_to_bin',
  'validate_password_strength', 'values', 'version', 'wait_for_executed_gtid_set', 'week', 'weekday', 'weekofyear', 'weight_string', 'year', 'yearweek',
]);

// 바로 '(' 가 붙어야 내장 함수인 이름 (소문자, MySQL lex.h 의 SYM_FN — 매뉴얼 "Function Name Parsing and Resolution" 의 목록에 JSON_ARRAYAGG·JSON_OBJECTAGG·ST_COLLECT 를 더한 35개).
// 공백·주석을 끼우면 식별자로 읽어 이름이 같은 저장 함수를 부른다 (NOW ()). IGNORE_SPACE 세션에서는 공백만 끼운 꼴도 내장 함수다 (주석을 끼우면 저장 함수)
export const ADJACENT_NATIVE_FUNCTIONS: ReadonlySet<string> = new Set([
  'adddate', 'bit_and', 'bit_or', 'bit_xor', 'cast', 'count', 'curdate', 'curtime', 'date_add', 'date_sub', 'extract', 'group_concat', 'json_arrayagg', 'json_objectagg',
  'max', 'mid', 'min', 'now', 'position', 'session_user', 'st_collect', 'std', 'stddev', 'stddev_pop', 'stddev_samp', 'subdate', 'substr', 'substring', 'sum', 'sysdate',
  'system_user', 'trim', 'var_pop', 'var_samp', 'variance',
]);

// MySQL 렉서가 건너뛰는 공백 (IGNORE_SPACE — 8.0.46·8.4.11 실측: 공백·탭·줄바꿈·CR·VT·FF. NBSP 는 이름의 글자로 읽는다)
const WHITESPACE = /^[ \t\n\r\v\f]+$/;

// 따옴표·스키마 없이 쓴 이름 name 을 gap(이름 끝과 '(' 사이의 원문 — 공백·주석) 뒤의 '(' 로 부르면 MySQL 이 내장 함수를 부르는가 (아니면 이름이 같은 저장 함수를 부른다).
// ignoreSpace: 세션 SQL_MODE 의 IGNORE_SPACE (모르면 undefined — 공백을 끼운 SYM_FN 이름도 저장 함수 호출로 본다, 보수적)
export function callsNativeFunction(name: string, gap: string, ignoreSpace: boolean | undefined): boolean {
  const lower = name.toLowerCase();
  if (NATIVE_FUNCTIONS.has(lower)) return true;
  if (!ADJACENT_NATIVE_FUNCTIONS.has(lower)) return false;
  return gap === '' || (ignoreSpace === true && WHITESPACE.test(gap));
}
