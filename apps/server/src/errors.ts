// 사용자에게 그대로 보여 줄 수 있는 오류. status는 HTTP 상태 코드
export class AppError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}
