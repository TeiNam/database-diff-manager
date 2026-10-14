import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireEditor, requireLogin } from '../auth/plugin';
import { AppError } from '../errors';
import { attachment } from '../http';
import { ALTER_BODY_LIMIT, MAX_ALTER_SCRIPT } from '../limits';
import { loadDerivation } from '../repos/derivations';
import { deleteVersion, getSource, getVersionMeta, listVersions, loadVersion } from '../repos/versions';
import { IdParams, NoteSchema, SafeFilename } from '../schemas';
import { applyAlter } from '../services/alter';
import { suggestAlterDefaults } from '../services/alter-defaults';

const CharsetName = z.string().regex(/^\w{1,64}$/, '문자셋·콜레이션 이름은 영문·숫자·_ 만 쓸 수 있습니다');
const AlterBody = z.object({
  script: z.string().min(1, '스크립트가 비어 있습니다').max(MAX_ALTER_SCRIPT, `스크립트는 ${MAX_ALTER_SCRIPT}자 이하여야 합니다`),
  filename: SafeFilename.optional(),
  note: NoteSchema.optional(),
  dryRun: z.boolean().optional(),
  defaults: z.object({ charset: CharsetName.optional(), collation: CharsetName.optional() }).optional(),
});

export function versionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/schemas/:id/versions', { onRequest: requireLogin }, async (req) => listVersions(ctx.db, IdParams.parse(req.params).id));

  app.get('/versions/:id', { onRequest: requireLogin }, async (req) => loadVersion(ctx.db, IdParams.parse(req.params).id));

  app.get('/versions/:id/source', { onRequest: requireLogin }, async (req, reply) => {
    const { filename, text } = getSource(ctx.db, IdParams.parse(req.params).id);
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', attachment(filename))
      .send(text);
  });

  // 권한은 본문을 읽기 전(onRequest)에 확인한다. 익명 요청이 큰 본문을 보내 파싱까지 가지 않도록
  app.post('/versions/:id/alter', { onRequest: requireEditor, bodyLimit: ALTER_BODY_LIMIT }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return applyAlter(ctx.db, { baseId: id, ...AlterBody.parse(req.body), userId: req.user!.id, requestId: req.id, log: req.log });
  });

  app.get('/versions/:id/derivation', { onRequest: requireLogin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    getVersionMeta(ctx.db, id); // 없는 버전은 404
    const derivation = loadDerivation(ctx.db, id);
    if (!derivation) throw new AppError(404, 'ALTER 적용으로 만든 버전이 아닙니다');
    return derivation;
  });

  // ALTER 적용 대화상자의 스키마 기본값 제안: 기준 버전 테이블의 DEFAULT CHARSET·COLLATE 최빈값. 알 수 있는 테이블이 없으면 defaults 는 null.
  // /derivation 은 ALTER 로 만든 버전에만 있어(그 밖은 404) 아직 ALTER 를 적용한 적 없는 스키마의 기준 버전에는 쓸 수 없다
  app.get('/versions/:id/alter-defaults', { onRequest: requireLogin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return { defaults: suggestAlterDefaults(loadVersion(ctx.db, id).model.tables) };
  });

  app.delete('/versions/:id', { onRequest: requireEditor }, async (req) => {
    deleteVersion(ctx.db, IdParams.parse(req.params).id);
    ctx.cache.clear(); // SQLite rowid가 재사용될 수 있으므로 캐시 전체를 비운다
    return { ok: true };
  });
}
