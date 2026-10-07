const pad = (n: number) => String(n).padStart(2, '0');

// 서버는 UTC ISO(Z)로 저장하므로 화면에서는 브라우저의 로컬 시간대로 바꿔 보여 준다.
// 해석할 수 없는 값은 가리지 않고 원문 그대로 돌려준다
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
