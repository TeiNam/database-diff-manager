// 실수 방지: 지울 대상의 이름을 그대로 입력해야 true (앞뒤 공백은 무시한다)
export function confirmByName(label: string, name: string): boolean {
  const typed = window.prompt(`${label} '${name}'과(와) 그 아래 모든 버전·객체 이력을 삭제합니다. 되돌릴 수 없습니다.\n확인하려면 이름을 입력하세요.`);
  if (typed === null) return false;
  if (typed.trim() !== name) {
    window.alert('이름이 일치하지 않아 삭제하지 않았습니다');
    return false;
  }
  return true;
}
