// 리포트 <style> 에 넣을 CSS: 밝은 테마 토큰 + 재사용 컴포넌트의 CSS 모듈 원문 + 리포트 전용 스타일 (설계 §4)
// ?inline 은 같은 빌드에서 화면 import 와 같은 클래스 이름으로 바꾼 CSS 를 문자열로 준다 (Vite 8.3.3 프로덕션 빌드로 확인).
// vitest 는 CSS 를 처리하지 않아(css.include 기본값 []) 테스트에서는 모두 빈 문자열이다 — 스타일은 프로덕션 빌드에서 확인한다
import bannerCss from '../../components/Banner.module.css?inline';
import markCss from '../../components/Mark.module.css?inline';
import tokensCss from '../../styles/tokens.css?inline';
import diffCss from '../diff/diff.module.css?inline';
import gridCss from '../diff/GridDiff.module.css?inline';
import cardCss from '../diff/ObjectCard.module.css?inline';
import sqlCss from '../diff/SqlDiff.module.css?inline';
import reportCss from './report.css?inline';

export const REPORT_CSS = [tokensCss, bannerCss, markCss, diffCss, cardCss, sqlCss, gridCss, reportCss].join('\n');
