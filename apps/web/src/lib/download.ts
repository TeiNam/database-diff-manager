// 텍스트를 파일로 내려받는다. type: Blob MIME (기본은 일반 텍스트)
export function downloadText(filename: string, text: string, type = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // 클릭 직후 해제하면 일부 브라우저에서 다운로드가 시작되기 전에 URL 이 사라진다
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
