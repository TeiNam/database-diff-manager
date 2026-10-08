export interface SchemaRef {
  id: number;
  name: string;
}

// Task 6 에서 미리보기·업로드를 채운다
export function MigrationUploadDialog({ onClose }: { from: SchemaRef; to: SchemaRef; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="전환 매핑 올리기">
      <button type="button" onClick={onClose}>닫기</button>
    </div>
  );
}
