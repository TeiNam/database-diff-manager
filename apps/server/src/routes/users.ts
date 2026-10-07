import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { hashPassword } from '../auth/password';
import { requireAdmin } from '../auth/plugin';
import { createUser, listUsers, updateUser } from '../repos/users';
import { IdParams, PasswordSchema, RoleSchema, UsernameSchema } from '../schemas';

const CreateUserBody = z.object({ username: UsernameSchema, password: PasswordSchema, role: RoleSchema });
const PatchUserBody = z
  .object({ role: RoleSchema.optional(), disabled: z.boolean().optional(), password: PasswordSchema.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), '변경할 항목이 없습니다');

export function userRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => listUsers(ctx.db));

  app.post('/', async (req, reply) => {
    const body = CreateUserBody.parse(req.body);
    const user = createUser(ctx.db, { username: body.username, role: body.role, passwordHash: await hashPassword(body.password) });
    return reply.status(201).send(user);
  });

  app.patch('/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = PatchUserBody.parse(req.body);
    return updateUser(ctx.db, id, {
      role: body.role,
      disabled: body.disabled,
      passwordHash: body.password ? await hashPassword(body.password) : undefined,
    });
  });
}
