// 업로드·본문 크기 제한 상수 (app.ts와 라우트가 공유해 순환 import를 피한다)
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 20;
export const JSON_BODY_LIMIT = 1024 * 1024;
export const UPLOAD_BODY_LIMIT = MAX_UPLOAD_BYTES * MAX_UPLOAD_FILES + 1024 * 1024;
