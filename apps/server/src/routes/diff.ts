import type { RenameMapping } from '@tdm/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireLogin } from '../auth/plugin';
import { AppError } from '../errors';
import { replaceRenames } from '../repos/renames';
import { loadVersion } from '../repos/versions';
import { RenameMappingSchema } from '../schemas';
import { computeDiff, dmsRenamesFor, latestMigrationFor } from '../services/diff-service';

const VersionId = z.coerce.number().int().positive();
const DiffQuery = z.object({ base: VersionId, target: VersionId });
const MAX_RENAMES = 500;
const MAX_DMS_RULES = 20_000; // DMS 에서 나온 rename 을 그대로 되돌려 보내는 클라이언트를 받아 주기 위한 여유
const RenamesBody = DiffQuery.extend({ renames: z.array(RenameMappingSchema).max(MAX_RENAMES + MAX_DMS_RULES) });
const renameKey = (r: RenameMapping) => `${r.kind}:${r.table ?? ''}:${r.from}`;

// DMS 에서 온 rename(kind, table, from, to 가 모두 같은 것)은 수동 매핑으로 저장하지 않는다
function toManualRenames(submitted: RenameMapping[], dms: RenameMapping[]): RenameMapping[] {
  const dmsFull = new Set(dms.map((r) => `${renameKey(r)}>${r.to}`));
  const manual = submitted.filter((r) => !dmsFull.has(`${renameKey(r)}>${r.to}`));
  if (manual.length > MAX_RENAMES) throw new AppError(400, `rename 매핑은 최대 ${MAX_RENAMES}개까지 저장할 수 있습니다`);
  if (new Set(manual.map(renameKey)).size !== manual.length) throw new AppError(400, '같은 대상에 대한 매핑이 중복되었습니다');
  return manual;
}

export function diffRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', requireLogin);

  app.get('/', async (req) => {
    const { base, target } = DiffQuery.parse(req.query);
    return computeDiff(ctx.db, ctx.cache, base, target);
  });

  app.put('/renames', async (req) => {
    const { base, target, renames } = RenamesBody.parse(req.body);
    const migration = latestMigrationFor(ctx.db, base, target); // 버전이 없으면 여기서 404
    const dms = migration ? dmsRenamesFor(migration, loadVersion(ctx.db, base).model, loadVersion(ctx.db, target).model) : [];
    replaceRenames(ctx.db, base, target, toManualRenames(renames, dms), req.user!.id);
    return computeDiff(ctx.db, ctx.cache, base, target);
  });
}
