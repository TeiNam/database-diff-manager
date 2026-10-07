import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useLogin, useMe } from '../api/hooks';
import { Footer } from '../layout/Footer';
import { APP_ENGINE, APP_NAME } from '../meta';
import s from './LoginPage.module.css';

export function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  if (me.data) return <Navigate to="/" replace />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ username, password }, { onSuccess: () => navigate('/', { replace: true }) });
  };
  return (
    <main className={s.page}>
      <form className={s.card} onSubmit={submit}>
        <h1 className={s.title}>{APP_NAME}</h1>
        <p className={s.engine}>{APP_ENGINE}</p>
        <label className={s.field}>
          사용자명
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label className={s.field}>
          비밀번호
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {login.error && <p role="alert" className={s.error}>{login.error.message}</p>}
        <button type="submit" className={s.submit} disabled={login.isPending}>로그인</button>
      </form>
      <Footer />
    </main>
  );
}
