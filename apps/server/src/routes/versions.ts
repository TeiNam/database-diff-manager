import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { requireEditor, requireLogin } from '../auth/plugin';
import { attachment } from '../http';
import { deleteVersion, getSource, listVersions, loadVersion } from '../repos/versions';
import { IdParams } from '../schemas';

export function versionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/schemas/:id/versions', { preHandler: requireLogin }, async (req) => listVersions(ctx.db, IdParams.parse(req.params).id));

  app.get('/versions/:id', { preHandler: requireLogin }, async (req) => loadVersion(ctx.db, IdParams.parse(req.params).id));

  app.get('/versions/:id/source', { preHandler: requireLogin }, async (req, reply) => {
    const { filename, text } = getSource(ctx.db, IdParams.parse(req.params).id);
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', attachment(filename))
      .send(text);
  });

  app.delete('/versions/:id', { preHandler: requireEditor }, async (req) => {
    deleteVersion(ctx.db, IdParams.parse(req.params).id);
    ctx.cache.clear(); // SQLite rowid가 재사용될 수 있으므로 캐시 전체를 비운다
    return { ok: true };
  });
}
