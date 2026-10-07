import { APP_NAME, APP_VERSION, AUTHOR, GITHUB_URL } from '../meta';
import s from './Footer.module.css';

export function Footer() {
  return (
    <footer className={s.footer}>
      <span>{APP_NAME} v{APP_VERSION}</span>
      <span aria-hidden="true">·</span>
      <span>Made by {AUTHOR}</span>
      <span aria-hidden="true">·</span>
      <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
    </footer>
  );
}
