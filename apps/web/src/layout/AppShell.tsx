import { useEffect, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, useNavigate } from 'react-router';
import { UNAUTHORIZED_EVENT } from '../api/client';
import { queryKeys, useMe } from '../api/hooks';
import s from './AppShell.module.css';
import { Footer } from './Footer';
import { Sidebar } from './Sidebar';
import { SidebarResizer } from './SidebarResizer';
import { Topbar } from './Topbar';
import { useSidebarWidth } from './useSidebarWidth';

export function AppShell() {
  const me = useMe();
  const navigate = useNavigate();
  const client = useQueryClient();
  const sidebar = useSidebarWidth();
  useEffect(() => {
    // 만료된 세션의 캐시를 비워야 로그인 화면이 남은 me 값을 보고 다시 홈으로 되돌리지 않는다
    const onUnauthorized = () => {
      client.clear();
      client.setQueryData(queryKeys.me, null);
      navigate('/login', { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate, client]);
  if (me.isPending) return <p className={s.loading}>불러오는 중…</p>;
  if (!me.data) return <Navigate to="/login" replace />;
  return (
    <div className={s.shell}>
      <Topbar me={me.data} />
      <div className={s.body} style={{ '--sidebar-w': `${sidebar.width}px` } as CSSProperties}>
        <Sidebar />
        <SidebarResizer width={sidebar.width} onChange={sidebar.setWidth} onCommit={sidebar.saveWidth} onReset={sidebar.reset} />
        <main className={s.main} id="main">
          <Outlet />
        </main>
      </div>
      <Footer />
    </div>
  );
}
