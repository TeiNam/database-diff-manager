// ENUM·SET 기본값의 멤버 찾기 (리뷰 2회차 R2-02·3회차 R3-02·M-3). MySQL 은 컬럼의 실제 콜레이션(테이블에서 물려받은 것 포함)으로 멤버를 하나씩 견주어
// 처음 같은 멤버를 쓴다 (find_type2). 그 비교를 재현할 수 있을 때만 판정한다 (MySQL 8.0.46·8.4.11 실측 — 아래 콜레이션마다 MEASURED_ASCII 글자를 모두 DEFAULT 로 견주었다):
// - binary 문자셋·_bin 콜레이션: 바이트·코드 포인트 비교라 글자가 같은 멤버만 맞는다 (기본 문자셋이 binary 인 테이블의 ENUM 은 SHOW CREATE 에 콜레이션이 없어도 같다)
// - 표준 _ci (ASCII_CI): ASCII 끼리는 대소문자만 무시한다. 대소문자만 다른 멤버가 둘이면(엄격하지 않은 세션에서 만든 기준 컬럼) 처음 것이다 (ENUM('a','A') 의 'A' → 'a')
// - 표준 _cs (ASCII_CS): ASCII 끼리는 글자가 같아야 한다
// 언어별 콜레이션(utf8mb4_turkish_ci 의 'I' 는 'i' 가 아니라 'ı', utf8mb4_roman_ci 의 'J' 는 'i', utf8mb4_lithuanian_ci 의 'Y' 는 'i', big5_chinese_ci 의 '`' 는 'E',
// 덴마크어 'aa' 는 'å' …)과 ASCII 가 아닌 글자(utf8mb4_0900_ai_ci 의 'cafe' 는 'café')는 비교를 재현하지 않는다. 그때도 글자까지 같은 멤버는 그 멤버다 — 엄격 SQL_MODE 는
// 콜레이션으로 같은 멤버를 1291 로 거부해 멤버끼리는 서로 다르다. 그 밖의 값은 RE_EXPORT 로 거부한다
// 한계: 엄격하지 않은 세션에서 콜레이션으로 같은 멤버를 둔 정의(ENUM('e','é') — MySQL 은 note 1291 만 남긴다)의 DEFAULT 'é' 는 MySQL 이 앞의 'e' 를 쓰는데 'é' 로 둔다

// 비교를 잰 ASCII 글자: 탭~CR(0x09~0x0D)과 0x20~0x7E. 그 밖의 제어 문자는 UCA 콜레이션이 무시하는 글자라 뺀다
const MEASURED_ASCII = /^[\t\n\v\f\r -~]*$/;

// ASCII 를 대소문자만 무시하고 견주는 콜레이션. 문자셋의 기본 콜레이션이어도 big5_chinese_ci·gbk_chinese_ci·gb2312_chinese_ci('Y' = '~')·koi8u_general_ci('`' 를 무시)는 아니다
const ASCII_CI: ReadonlySet<string> = new Set([
  'utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_unicode_520_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_0900_as_ci',
  'utf8mb3_general_ci', 'utf8mb3_unicode_ci', 'utf8mb3_unicode_520_ci', 'ucs2_general_ci', 'ucs2_unicode_ci', 'ucs2_unicode_520_ci',
  'utf16_general_ci', 'utf16_unicode_ci', 'utf16_unicode_520_ci', 'utf16le_general_ci', 'utf32_general_ci', 'utf32_unicode_ci', 'utf32_unicode_520_ci',
  'latin1_swedish_ci', 'latin1_general_ci', 'latin2_general_ci', 'ascii_general_ci', 'cp1250_general_ci', 'cp1251_general_ci', 'cp1256_general_ci',
  'cp1257_general_ci', 'greek_general_ci', 'hebrew_general_ci', 'koi8r_general_ci', 'euckr_korean_ci', 'sjis_japanese_ci', 'ujis_japanese_ci',
  'cp932_japanese_ci', 'eucjpms_japanese_ci', 'gb18030_chinese_ci', 'tis620_thai_ci',
]);
// ASCII 를 글자가 같아야 맞게 견주는 _cs 콜레이션 (_bin 은 늘 글자가 같아야 한다)
const ASCII_CS: ReadonlySet<string> = new Set(['utf8mb4_0900_as_cs', 'latin1_general_cs', 'cp1251_general_cs']);

type Rule = 'bytes' | 'ascii-ci' | 'ascii-cs' | 'unknown';

function ruleOf(collation: string): Rule {
  const name = collation.replace(/^utf8_/, 'utf8mb3_'); // 옛 덤프의 utf8 이름
  if (name === 'binary' || name.endsWith('_bin')) return 'bytes';
  if (ASCII_CI.has(name)) return 'ascii-ci';
  return ASCII_CS.has(name) ? 'ascii-cs' : 'unknown';
}

// members 에서 기본값 value 에 맞는 멤버를 찾는 함수 (undefined: 맞는 멤버가 없다 — MySQL 1067). collation: 컬럼의 실제 콜레이션.
// 재현하지 않는 비교가 필요하면 reExport 로 거부한다
export function memberFinder(members: readonly string[], collation: string, reExport: (why: string) => never): (value: string) => string | undefined {
  const rule = ruleOf(collation);
  const asciiMembers = members.every((m) => MEASURED_ASCII.test(m));
  const lowered = rule === 'ascii-ci' && asciiMembers ? members.map((m) => m.toLowerCase()) : [];
  return (value) => {
    const ascii = asciiMembers && MEASURED_ASCII.test(value);
    if (rule === 'ascii-ci' && ascii) {
      const at = lowered.indexOf(value.toLowerCase());
      return at < 0 ? undefined : members[at];
    }
    const exact = members.includes(value) ? value : undefined;
    if (exact !== undefined || rule === 'bytes' || (rule === 'ascii-cs' && ascii)) return exact;
    return reExport(`'${value}' 와 글자까지 같은 멤버가 없는데, 콜레이션 ${collation} 이 대소문자·악센트·언어별 글자를 견주는 규칙은 재현하지 않습니다 (멤버와 같은 글자로 쓰세요)`);
  };
}
