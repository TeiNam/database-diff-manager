import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireAdmin, requireLogin } from '../auth/plugin';
import { attachment } from '../http';
import { MAX_UPLOAD_BYTES, MIGRATION_BODY_LIMIT } from '../limits';
import { getSchema } from '../repos/catalog';
import { deleteMigration, getMigrationSource, listMigrations } from '../repos/migrations';
import { IdParams, NoteSchema, SafeFilename } from '../schemas';
import { uploadMigration } from '../services/migration-service';

const Id = z.coerce.number().int().positive();
const UploadBody = z.object({
  fromSchemaId: Id,
  toSchemaId: Id,
  filename: SafeFilename,
  source: z.string().min(1, '파일이 비어 있습니다').max(MAX_UPLOAD_BYTES, `파일이 너무 큽니다 (최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`),
  note: NoteSchema.optional(),
});
const PairQuery = z.object({ from: Id, to: Id });

export function migrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/migrations', { preHandler: requireAdmin, bodyLimit: MIGRATION_BODY_LIMIT }, async (req, reply) => {
    const body = UploadBody.parse(req.body);
    const result = uploadMigration(ctx.db, { ...body, note: body.note || undefined, userId: req.user!.id });
    ctx.cache.clear(); // 쌍의 최신 매핑이 바뀌어 diff 결과가 달라진다
    return reply.status(201).send(result);
  });

  app.get('/migrations', { preHandler: requireLogin }, async (req) => {
    const { from, to } = PairQuery.parse(req.query);
    getSchema(ctx.db, from);
    getSchema(ctx.db, to);
    return listMigrations(ctx.db, from, to);
  });

  app.get('/migrations/:id/source', { preHandler: requireLogin }, async (req, reply) => {
    const { filename, text } = getMigrationSource(ctx.db, IdParams.parse(req.params).id);
    return reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', attachment(filename)).send(text);
  });

  app.delete('/migrations/:id', { preHandler: requireAdmin }, async (req) => {
    deleteMigration(ctx.db, IdParams.parse(req.params).id);
    ctx.cache.clear();
    return { ok: true };
  });
}
