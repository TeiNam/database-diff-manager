// localStorage 접근을 감싼다. 차단된 환경(사파리 비공개 모드·저장소 정책 등)에서는 예외 대신 기본값으로 동작한다
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// 저장하지 못해도 화면 동작은 그대로 둔다 (설정이 다음 방문에 남지 않을 뿐이다)
export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 의도적으로 무시: 저장소 차단은 기능 오류가 아니다
  }
}
