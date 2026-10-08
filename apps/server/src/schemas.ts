// 여러 라우트가 함께 쓰는 입력 검증 스키마
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from './auth/password';
import { ROLES, USERNAME_PATTERN } from './repos/users';

export const IdParams = z.object({ id: z.coerce.number().int().positive() });
export const RoleSchema = z.enum(ROLES);
export const UsernameSchema = z.string().regex(USERNAME_PATTERN, '사용자명은 영문·숫자·_.- 3~32자여야 합니다');
export const PasswordSchema = z.string().min(MIN_PASSWORD_LENGTH, `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`).max(256);
export const SafeFilename = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !/[/\\]/.test(v), '파일명에 경로 구분자를 쓸 수 없습니다');
export const NoteSchema = z.string().trim().max(500);
export const NameSchema = z.string().trim().min(1, '이름이 비어 있습니다').max(128);

export const RenameMappingSchema = z
  .object({ kind: z.enum(['table', 'column', 'index']), table: NameSchema.optional(), from: NameSchema, to: NameSchema })
  .refine((r) => (r.kind === 'table') === (r.table === undefined), 'column·index 매핑에는 table이 필요하고, table 매핑에는 없어야 합니다');
