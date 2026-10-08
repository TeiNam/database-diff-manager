// 텍스트를 클립보드에 복사한다. 내용을 비동기로 만들면(복사 직전 재조회 등) Promise 로 넘긴다.
// Safari 는 await 뒤의 writeText 를 사용자 동작 밖으로 보고 거부하므로, 가능하면 ClipboardItem 에 Promise 를 넘겨 클릭 안에서 쓰기를 시작한다
export async function copyText(text: string | Promise<string>): Promise<void> {
  const clipboard = navigator.clipboard;
  if (typeof text !== 'string' && clipboard?.write && typeof ClipboardItem !== 'undefined') {
    await clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
    return;
  }
  const value = await text;
  if (clipboard?.writeText) {
    await clipboard.writeText(value);
    return;
  }
  // HTTP(비보안 컨텍스트)에서는 navigator.clipboard 가 없으므로 textarea 선택 복사로 대체한다
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('클립보드에 복사하지 못했습니다');
}
