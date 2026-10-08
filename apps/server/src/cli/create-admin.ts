// 최초 관리자 생성: npm run create-admin -w @tdm/server -- <username>
// 비밀번호는 TTY 프롬프트로만 받는다 (env·CLI 인자 금지)
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../auth/password';
import { dbPath, loadConfig } from '../config';
import { closeDb, openDb, type Db } from '../db/connection';
import { createUser, type User } from '../repos/users';
import { PasswordSchema, UsernameSchema } from '../schemas';

export async function createAdmin(db: Db, username: string, password: string): Promise<User> {
  for (const [schema, value] of [[UsernameSchema, username], [PasswordSchema, password]] as const) {
    const result = schema.safeParse(value);
    if (!result.success) throw new Error(result.error.issues[0].message);
  }
  return createUser(db, { username, passwordHash: await hashPassword(password), role: 'admin' });
}

function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return Promise.reject(new Error('비밀번호는 터미널에서 직접 입력해야 합니다'));
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('취소되었습니다'));
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) throw new Error('사용법: npm run create-admin -w @tdm/server -- <username>');
  const password = await promptHidden('비밀번호: ');
  if (password !== (await promptHidden('비밀번호 확인: '))) throw new Error('비밀번호가 일치하지 않습니다');
  const db = openDb(dbPath(loadConfig()));
  try {
    const user = await createAdmin(db, username, password);
    console.log(`관리자 '${user.username}'을(를) 만들었습니다`);
  } finally {
    closeDb(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
