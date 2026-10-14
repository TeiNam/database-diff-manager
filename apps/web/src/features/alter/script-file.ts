// 서버가 파일 이름을 .sql 로 끝나게 요구한다. 끌어다 놓기와 '모든 파일' 선택은 input 의 accept 필터를 거치지 않는다
const SQL_FILE = /\.sql$/i;
// 덤프 업로드(서버 routes/uploads.ts)와 같은 기준: UTF-8 만 받는다. file.text() 는 잘못된 바이트를 U+FFFD 로 바꿔 읽어,
// CP949 로 저장한 스크립트의 한글 COMMENT·DEFAULT 가 깨진 채 저장되므로 쓰지 않는다. 앞의 BOM 은 기본으로 제거된다
const utf8 = new TextDecoder('utf-8', { fatal: true });

export type ScriptFileRead = { text: string } | { error: string };

// 고르거나 끌어다 놓은 파일을 스크립트 텍스트로 읽는다. 받지 못하면 화면에 그대로 보일 이유를 돌려준다
export async function readScriptFile(file: File): Promise<ScriptFileRead> {
  if (!SQL_FILE.test(file.name)) return { error: `${file.name}: .sql 파일만 받습니다` };
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (error) {
    return { error: `${file.name}: 파일을 읽지 못했습니다${error instanceof Error && error.message ? ` (${error.message})` : ''}` };
  }
  try {
    return { text: utf8.decode(bytes) };
  } catch {
    return { error: `${file.name}: UTF-8로 인코딩된 파일만 받습니다 — CP949·EUC-KR 등으로 저장했다면 UTF-8 로 다시 저장해 주세요` };
  }
}
