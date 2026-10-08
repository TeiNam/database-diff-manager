import type { Me, Role } from '../api/types';

type MaybeMe = Pick<Me, 'role'> | null | undefined;

// 역할 선택지 (권한이 낮은 순)
export const ROLE_OPTIONS: readonly Role[] = ['viewer', 'dba', 'admin'];

// 데이터 변경(업로드·삭제·전환 매핑·rename 저장)은 admin·dba 만 한다. viewer 는 읽기 전용
export const canEdit = (me: MaybeMe): boolean => me?.role === 'admin' || me?.role === 'dba';

// 계정 관리는 admin 만 한다
export const isAdmin = (me: MaybeMe): boolean => me?.role === 'admin';
