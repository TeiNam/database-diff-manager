import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLogout, useSchemaInfo } from '../api/hooks';
import type { Me } from '../api/types';
import { Icon } from '../components/Icon';
import { UploadDialog } from '../features/upload/UploadDialog';
import { useSchemaContext } from '../hooks/useSchemaContext';
import { canEdit, isAdmin } from '../lib/roles';
import { useTheme } from '../theme';
import { APP_ENGINE, APP_NAME, APP_VERSION } from '../meta';
import s from './Topbar.module.css';
import { VersionPicker } from './VersionPicker';

export function Topbar({ me }: { me: Me }) {
  const ctx = useSchemaContext();
  const schema = useSchemaInfo(ctx.schemaId);
  const { theme, toggle } = useTheme();
  const logout = useLogout();
  const navigate = useNavigate();
  const [uploading, setUploading] = useState(false);
  return (
    <header className={s.topbar}>
      <Link to="/" className={s.brand}>
        <span className={s.logo}><Icon name="swap" /></span>{APP_NAME}
        <span className={s.engine}>{APP_ENGINE}</span>
        <span className={s.version}>v{APP_VERSION}</span>
      </Link>
      {schema.data && (
        <nav className={s.crumb} aria-label="현재 위치">
          <span>{schema.data.databaseName}</span>
          <Icon name="chevronRight" />
          <b>{schema.data.name}</b>
        </nav>
      )}
      <div className={s.spacer} />
      {ctx.schemaId && <VersionPicker schemaId={ctx.schemaId} />}
      {ctx.schemaId && ctx.dbId && (
        <Link className={s.btn} to={`/db/${ctx.dbId}/schema/${ctx.schemaId}/history`}>
          <Icon name="history" />버전 이력
        </Link>
      )}
      {canEdit(me) && (
        <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => setUploading(true)}>
          <Icon name="upload" />업로드
        </button>
      )}
      {isAdmin(me) && (
        <Link className={s.iconBtn} to="/admin/users" aria-label="계정 관리" title="계정 관리">
          <Icon name="users" />
        </Link>
      )}
      <button type="button" className={s.iconBtn} onClick={toggle} aria-label={theme === 'dark' ? '라이트 테마로 전환' : '다크 테마로 전환'} title="테마 전환">
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <span className={s.user}>{me.username}</span>
      <button type="button" className={s.iconBtn} aria-label="로그아웃" title="로그아웃"
        onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}>
        <Icon name="logout" />
      </button>
      {uploading && <UploadDialog onClose={() => setUploading(false)} />}
    </header>
  );
}
