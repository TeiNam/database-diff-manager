import { Link } from 'react-router';
import s from './Page.module.css';

export function NotFoundPage() {
  return (
    <section className={s.page}>
      <h1 className={s.title}>페이지를 찾을 수 없습니다</h1>
      <Link to="/" className={s.btn}>처음으로</Link>
    </section>
  );
}
