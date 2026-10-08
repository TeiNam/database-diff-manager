// 다운로드 응답 헤더. RFC 5987 filename*: encodeURIComponent가 남기는 '()*도 인코딩한다
const encodeRfc5987 = (v: string) => encodeURIComponent(v).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const asciiFallback = (v: string) => v.replace(/[^\x20-\x7e]|["\\%]/g, '_');

export const attachment = (filename: string): string =>
  `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
