import type { ParseWarning } from '@tdm/core';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireAdmin } from '../auth/plugin';
import { AppError } from '../errors';
import { MAX_UPLOAD_FILES, UPLOAD_BODY_LIMIT } from '../limits';
import { NameSchema, NoteSchema, SafeFilename } from '../schemas';
import { ingest } from '../services/ingest';

export interface UploadResult {
  filename: string;
  status: 'ok' | 'duplicate' | 'error';
  versionId?: number;
  versionNo?: number;
  warnings: ParseWarning[];
  message?: string;
}

const FileMetaSchema = z.object({ filename: SafeFilename, databaseName: NameSchema, schemaName: NameSchema, note: NoteSchema.optional() });
type FileMeta = z.infer<typeof FileMetaSchema>;
const MetaSchema = z.array(FileMetaSchema).min(1).max(MAX_UPLOAD_FILES);

const utf8 = new TextDecoder('utf-8', { fatal: true }); // 앞의 BOM은 기본으로 제거된다

function decodeUtf8(buffer: Buffer): string {
  try {
    return utf8.decode(buffer);
  } catch {
    throw new AppError(400, 'UTF-8로 인코딩된 파일만 올릴 수 있습니다');
  }
}

function parseMeta(raw: string | undefined): FileMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? 'null');
  } catch {
    throw new AppError(400, 'meta 필드가 올바른 JSON이 아닙니다');
  }
  const meta = MetaSchema.parse(parsed);
  if (new Set(meta.map((m) => m.filename)).size !== meta.length) throw new AppError(400, '같은 파일명이 meta에 두 번 들어 있습니다');
  return meta;
}

export function uploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 파일 크기는 multipart limits(파일당 20MB)로 제한한다. JSON용 기본 bodyLimit(1MB)이 업로드에 걸리지 않도록 라우트 한도를 넓힌다
  app.post('/', { preHandler: requireAdmin, bodyLimit: UPLOAD_BODY_LIMIT }, async (req) => {
    if (!req.isMultipart()) throw new AppError(400, 'multipart/form-data 요청이어야 합니다');
    const files = new Map<string, Buffer>();
    let metaRaw: string | undefined;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (files.has(part.filename)) throw new AppError(400, `같은 파일명이 두 번 포함되었습니다: ${part.filename}`);
        files.set(part.filename, await part.toBuffer());
      } else if (part.fieldname === 'meta') {
        metaRaw = String(part.value);
      }
    }
    const meta = parseMeta(metaRaw);
    const results = meta.map((m) => uploadOne(ctx, req.log, req.user!.id, m, files.get(m.filename)));
    const described = new Set(meta.map((m) => m.filename));
    for (const filename of files.keys()) {
      if (!described.has(filename)) results.push({ filename, status: 'error', warnings: [], message: '메타 정보가 없는 파일입니다' });
    }
    return { results };
  });
}

function uploadOne(ctx: AppContext, log: FastifyBaseLogger, userId: number, meta: FileMeta, buffer: Buffer | undefined): UploadResult {
  const { filename } = meta;
  if (!buffer) return { filename, status: 'error', warnings: [], message: '파일이 첨부되지 않았습니다' };
  try {
    const result = ingest(ctx.db, { ...meta, text: decodeUtf8(buffer), userId });
    if (result.status === 'ok') return { filename, ...result };
    return { filename, ...result, message: `v${result.versionNo}와 내용이 같습니다` };
  } catch (e) {
    if (e instanceof AppError) return { filename, status: 'error', warnings: [], message: e.message };
    // 한 파일의 예기치 않은 오류가 다른 파일 처리를 막지 않도록 격리한다
    log.error({ err: e, filename }, '업로드 파일 처리 중 오류');
    return { filename, status: 'error', warnings: [], message: '파일을 처리하지 못했습니다' };
  }
}
