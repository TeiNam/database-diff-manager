import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { requireLogin } from '../auth/plugin';
import { objectHistory } from '../repos/objects';
import { IdParams } from '../schemas';

export function objectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/:id/history', { preHandler: requireLogin }, async (req) => objectHistory(ctx.db, IdParams.parse(req.params).id));
}
