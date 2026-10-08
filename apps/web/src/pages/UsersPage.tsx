import { useState, type FormEvent } from 'react';
import { useCreateUser, useMe, usePatchUser, useUsers } from '../api/hooks';
import type { Role } from '../api/types';
import { isAdmin as isAdminUser, ROLE_OPTIONS } from '../lib/roles';
import s from './Page.module.css';

const MIN_PASSWORD_LENGTH = 10;

function CreateUserForm() {
  const create = useCreateUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ username, password, role }, { onSuccess: () => { setUsername(''); setPassword(''); } });
  };
  return (
    <form className={s.row} onSubmit={submit} aria-label="계정 만들기">
      <input className={s.input} aria-label="새 사용자명" placeholder="사용자명" value={username} onChange={(e) => setUsername(e.target.value)} required />
      <input className={s.input} aria-label="초기 비밀번호" type="password" placeholder="비밀번호 (10자 이상)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
      <select className={s.input} aria-label="역할" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <button type="submit" className={s.btn} disabled={create.isPending}>계정 만들기</button>
      {create.error && <span role="alert" className={s.error}>{create.error.message}</span>}
    </form>
  );
}

export function UsersPage() {
  const me = useMe();
  const isAdmin = isAdminUser(me.data);
  const users = useUsers(isAdmin);
  const patch = usePatchUser();
  const [resetError, setResetError] = useState<string | null>(null);
  if (me.isPending) return <section className={s.page}><p className={s.muted}>불러오는 중…</p></section>;
  if (!isAdmin) return <section className={s.page}><p className={s.empty}>관리자만 볼 수 있습니다</p></section>;
  const resetPassword = (id: number) => {
    const password = window.prompt('새 비밀번호 (10자 이상)');
    if (!password) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setResetError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`);
      return;
    }
    setResetError(null);
    patch.mutate({ id, password });
  };
  return (
    <section className={s.page}>
      <h1 className={s.title}>계정 관리</h1>
      <CreateUserForm />
      {resetError && <p role="alert" className={s.error}>{resetError}</p>}
      {patch.error && <p role="alert" className={s.error}>{patch.error.message}</p>}
      <table className={s.table}>
        <thead><tr><th>사용자명</th><th>역할</th><th>상태</th><th /></tr></thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id}>
              <td className="mono">{u.username}</td>
              <td>
                <select className={s.input} aria-label={`${u.username} 역할`} value={u.role} onChange={(e) => patch.mutate({ id: u.id, role: e.target.value as Role })}>
                  {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td>{u.disabled ? '비활성' : '활성'}</td>
              <td>
                <div className={s.row}>
                  <button type="button" className={s.btn} aria-label={`${u.username} ${u.disabled ? '활성화' : '비활성화'}`} onClick={() => patch.mutate({ id: u.id, disabled: !u.disabled })}>{u.disabled ? '활성화' : '비활성화'}</button>
                  <button type="button" className={s.btn} aria-label={`${u.username} 비밀번호 재설정`} onClick={() => resetPassword(u.id)}>비밀번호 재설정</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
