import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireEditor, requireLogin } from '../auth/plugin';
import { createDatabase, deleteDatabase, deleteSchema, getSchema, getTree, updateDatabase } from '../repos/catalog';
import { IdParams, NameSchema } from '../schemas';

const DescriptionSchema = z.string().trim().max(500);
const CreateBody = z.object({ name: NameSchema, description: DescriptionSchema.optional() });
const PatchBody = z
  .object({ name: NameSchema.optional(), description: DescriptionSchema.optional() })
  .refine((v) => v.name !== undefined || v.description !== undefined, '변경할 항목이 없습니다');
const DeleteBody = z.object({ confirmName: z.string() });

export function catalogRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/tree', { preHandler: requireLogin }, async () => getTree(ctx.db));

  app.get('/schemas/:id', { preHandler: requireLogin }, async (req) => getSchema(ctx.db, IdParams.parse(req.params).id));

  app.delete('/schemas/:id', { preHandler: requireEditor }, async (req) => {
    deleteSchema(ctx.db, IdParams.parse(req.params).id, DeleteBody.parse(req.body).confirmName);
    ctx.cache.clear(); // 버전이 연쇄 삭제되므로 diff 캐시를 비운다(rowid 재사용 대비)
    return { ok: true };
  });

  app.post('/databases', { preHandler: requireEditor }, async (req, reply) => {
    return reply.status(201).send(createDatabase(ctx.db, CreateBody.parse(req.body)));
  });

  app.patch('/databases/:id', { preHandler: requireEditor }, async (req) => {
    return updateDatabase(ctx.db, IdParams.parse(req.params).id, PatchBody.parse(req.body));
  });

  app.delete('/databases/:id', { preHandler: requireEditor }, async (req) => {
    deleteDatabase(ctx.db, IdParams.parse(req.params).id, DeleteBody.parse(req.body).confirmName);
    ctx.cache.clear(); // 버전이 연쇄 삭제되므로 diff 캐시를 비운다(rowid 재사용 대비)
    return { ok: true };
  });
}
