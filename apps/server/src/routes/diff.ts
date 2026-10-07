import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireLogin } from '../auth/plugin';
import { replaceRenames } from '../repos/renames';
import { getVersionMeta } from '../repos/versions';
import { RenameMappingSchema } from '../schemas';
import { computeDiff } from '../services/diff-service';

const VersionId = z.coerce.number().int().positive();
const DiffQuery = z.object({ base: VersionId, target: VersionId });
const MAX_RENAMES = 500;
const RenamesBody = DiffQuery.extend({ renames: z.array(RenameMappingSchema).max(MAX_RENAMES) }).refine(
  (b) => new Set(b.renames.map((r) => `${r.kind}:${r.table ?? ''}:${r.from}`)).size === b.renames.length,
  '같은 대상에 대한 매핑이 중복되었습니다',
);

export function diffRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', requireLogin);

  app.get('/', async (req) => {
    const { base, target } = DiffQuery.parse(req.query);
    return computeDiff(ctx.db, ctx.cache, base, target);
  });

  app.put('/renames', async (req) => {
    const { base, target, renames } = RenamesBody.parse(req.body);
    getVersionMeta(ctx.db, base);
    getVersionMeta(ctx.db, target);
    replaceRenames(ctx.db, base, target, renames, req.user!.id);
    return computeDiff(ctx.db, ctx.cache, base, target);
  });
}
