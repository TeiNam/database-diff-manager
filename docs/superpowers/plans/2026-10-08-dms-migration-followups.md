# DMS 전환 매핑 후속 과제 (backlog)

Plan 4 최종 리뷰에서 머지 후로 미룬 항목.

## core
- rule-id 없는 룰의 `#N` 문자열 비교 순서; `invalid` 경고가 룰 순서와 다르게 나옴
- 같은 missing 컬럼 룰이 중복되면 행이 2개; exclude 대상인 없는 include 가 `missing-source` 로 표시
- As-Is 에 대소문자만 다른 컬럼(`A`, `a`)이 함께 있으면 둘 다 같은 To-Be 대상으로 풀리는 모호함
- 미지원 DMS action(add-column, change-data-type, 대소문자·접두사 변환, 인덱스 룰) 반영

## server
- 캐시 비움을 직접 확인하는 테스트; zod `max` 가 UTF-16 글자 수 기준(바이트 아님)
- schema-name 불일치 경고가 `code: 'invalid'` 재사용 → 별도 코드

## web
- viewer 에게 리비전 삭제 버튼이 없음을 확인하는 테스트
- 경고 목록 `li` 를 닫혀 있어도 모두 렌더
- 업로드 중 Escape·배경 클릭으로 닫힘; 서버 오류 테스트가 403 만 확인
- MigrationUploadDialog 가 UploadDialog.module.css 를 공유 → 공용 대화상자 스타일 모듈로
- 로그아웃 직후 남은 쿼리가 401 을 2건 남김(무해)
- 전환 표 CSV·엑셀 내보내기, 역방향 비교에 매핑 반전 적용
