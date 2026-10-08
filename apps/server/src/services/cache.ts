import type { MigrationFlow } from '@tdm/core';
import type { DiffResponse } from './diff-service';
import type { ParsedMigration } from './migration-service';

// 최근에 쓴 항목을 남기는 LRU. 꺼낼 때 맨 뒤로 옮기고, 넘치면 가장 오래 안 쓴 것부터 버린다
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}

// 캐시에 보관하는 최대 항목 수
const DIFF_CACHE_SIZE = 50;
const MIGRATION_CACHE_SIZE = 20;

// 서버 메모리 캐시 묶음. 버전·매핑·Schema·DB 를 지우거나 매핑을 올리면 clear() 로 한꺼번에 비운다(SQLite rowid 재사용 대비)
export class AppCache {
  // 키: base·target 버전, 전환 매핑 방향·id, 수동 rename 매핑
  readonly diff = new LruCache<DiffResponse>(DIFF_CACHE_SIZE);
  // 키: 전환 매핑 id. 원문 파싱 결과(mapping + warnings)
  readonly parsed = new LruCache<ParsedMigration>(MIGRATION_CACHE_SIZE);
  // 키: 전환 매핑 id + As-Is 버전 + To-Be 버전
  readonly flows = new LruCache<MigrationFlow>(DIFF_CACHE_SIZE);

  clear(): void {
    this.diff.clear();
    this.parsed.clear();
    this.flows.clear();
  }
}
