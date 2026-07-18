// visualize 위젯 뷰 계약 — 렌더 원본(code)과 감지된 모드. 문서 빌더(여기,
// feature-artifacts)가 shape의 owner이고, assistant 쪽 파서가 이 타입을
// 가져다 쓴다 (경계 방향: assistant → artifacts).
export interface VisualizeWidgetView {
  mode: 'svg' | 'html';
  code: string;
  title: string | null;
}

// visualize 인라인 위젯 문서 — 아티팩트와 같은 iframe 런타임을 타지만
// 생명주기는 tool_call에 묶인 턴 출력이다. 채팅에 녹아들도록 배경은
// 투명하고, 셸 테마(tokens.css의 Modern Heritage 값)와 데이터 시리즈
// 팔레트를 CSS 변수·프리셋 클래스로 미리 얹어 둔다. sendPrompt/resize
// helper는 buildHtmlArtifactRuntimePayload 주입 경로가 공통으로 붙인다.
//
interface VisualizeSeriesSlot {
  name: string;
  variable: string;
}

// c-teal / c-amber는 위젯 관례상 자주 쓰이는 별칭 — aqua / yellow 슬롯을
// 가리킨다.
const VISUALIZE_SERIES_SLOTS: readonly VisualizeSeriesSlot[] = [
  { name: 'blue', variable: '--series-1' },
  { name: 'green', variable: '--series-2' },
  { name: 'magenta', variable: '--series-3' },
  { name: 'yellow', variable: '--series-4' },
  { name: 'amber', variable: '--series-4' },
  { name: 'aqua', variable: '--series-5' },
  { name: 'teal', variable: '--series-5' },
  { name: 'orange', variable: '--series-6' },
  { name: 'violet', variable: '--series-7' },
  { name: 'red', variable: '--series-8' },
];

function buildSeriesClassRules(): string {
  return VISUALIZE_SERIES_SLOTS.map(
    (slot) => `
  .c-${slot.name} rect,
  .c-${slot.name} circle,
  .c-${slot.name} path.fill {
    fill: var(${slot.variable});
    stroke: none;
  }
  .c-${slot.name} text {
    fill: #ffffff;
  }
  .c-${slot.name} {
    color: var(${slot.variable});
  }`,
  ).join('\n');
}

// 시리즈 색은 검증된 기본 팔레트(디자인 노트 palette.md)의 라이트 컬럼을
// 슬롯 순서 그대로 쓴다 — 순서 자체가 CVD 안전 장치라 임의로 섞지 않는다.
const VISUALIZE_WIDGET_STYLE = `
  :root {
    color-scheme: light;
    --surface-1: #ffffff;
    --surface-2: #f5f1e8;
    --hairline: #ddd5c4;
    --text-primary: #322214;
    --text-secondary: #8a7a64;
    --series-1: #2a78d6;
    --series-2: #008300;
    --series-3: #e87ba4;
    --series-4: #eda100;
    --series-5: #1baf7a;
    --series-6: #eb6834;
    --series-7: #4a3aa7;
    --series-8: #e34948;
    font-family:
      'Pretendard',
      'Inter',
      system-ui,
      -apple-system,
      'Segoe UI',
      'Apple SD Gothic Neo',
      sans-serif;
  }
  * {
    box-sizing: border-box;
  }
  html,
  body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--text-primary);
  }
  .geulbat-visualize-root {
    padding: 2px;
  }
  .t {
    font-size: 13px;
    fill: var(--text-primary);
    color: var(--text-primary);
  }
  .th {
    font-size: 14px;
    font-weight: 600;
    fill: var(--text-primary);
    color: var(--text-primary);
  }
  .ts {
    font-size: 12px;
    fill: var(--text-secondary);
    color: var(--text-secondary);
  }
  .box {
    fill: var(--surface-2);
    stroke: var(--hairline);
    stroke-width: 1;
  }
  .node {
    cursor: pointer;
  }
  .node rect {
    fill: var(--surface-2);
    stroke: var(--hairline);
    stroke-width: 1;
  }
  .node text {
    fill: var(--text-primary);
  }
  .arr {
    stroke: var(--text-secondary);
    stroke-width: 1.5;
    fill: none;
  }
  .node:hover rect,
  .node:hover circle {
    filter: brightness(1.05);
  }
  ${buildSeriesClassRules()}
  svg {
    display: block;
    max-width: 100%;
    height: auto;
  }
  svg text {
    font-family: inherit;
  }
  .geulbat-visualize-root button {
    padding: 6px 12px;
    border: 1px solid var(--hairline);
    border-radius: 8px;
    background: var(--surface-1);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.4;
    cursor: pointer;
  }
  .geulbat-visualize-root button:hover {
    background: var(--surface-2);
  }
  .geulbat-visualize-root a {
    color: var(--series-1);
  }
`;

// #arrow 마커 정의 — 위젯 SVG가 marker-end="url(#arrow)"로 바로 쓸 수 있게
// 숨은 defs로 항상 깔아 둔다.
const VISUALIZE_WIDGET_SVG_DEFS = [
  '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">',
  '<defs>',
  '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
  '<path d="M 0 0 L 10 5 L 0 10 z" fill="#8a7a64"></path>',
  '</marker>',
  '</defs>',
  '</svg>',
].join('');

// 실데이터 스트리밍 수신 문서 — 문서 자체는 고정이고, 부모가
// geulbat.visualize.stream_update postMessage로 코드를 밀어 넣을 때마다
// 완결된 태그 프리픽스만 반영해 그려지는 과정을 보여준다. (innerHTML
// 경로라 <script>는 실행되지 않는다 — 완성본 위젯이 실행을 담당.)
export const VISUALIZE_STREAM_UPDATE_MESSAGE_KIND =
  'geulbat.visualize.stream_update';

export function buildVisualizeWidgetStreamDocument(args: {
  title: string | null;
}): string {
  const titleText = args.title ?? 'visualize widget';
  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtmlText(titleText)}</title>`,
    `<style>${VISUALIZE_WIDGET_STYLE}</style>`,
    '</head>',
    '<body>',
    VISUALIZE_WIDGET_SVG_DEFS,
    '<div class="geulbat-visualize-root" id="geulbat-visualize-root"></div>',
    '<script>',
    `(() => {
  const root = document.getElementById('geulbat-visualize-root');
  const parentOrigin = window.__GEULBAT_PARENT_ORIGIN__;
  if (!root) {
    return;
  }
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 속도 제한 리빌 — 델타가 몰아서 도착해도(긴 추론 뒤 폭주) 과정이
  // 보이도록 태그 경계 단위로 따라잡는다. 밀린 분량이 커도 ~2.5초 안에
  // 따라잡고, 실시간 스트리밍이면 도착 즉시 그린다.
  const STEP_MS = 45;
  const MAX_CATCHUP_STEPS = Math.max(1, Math.round(2500 / STEP_MS));
  let targetCode = '';
  let done = false;
  let revealedSegments = 0;
  let timer = 0;
  const applyStep = () => {
    const boundary = done
      ? targetCode
      : targetCode.slice(0, targetCode.lastIndexOf('>') + 1);
    if (!boundary) {
      return false;
    }
    const segments = boundary.split(/(?=<)/);
    if (revealedSegments >= segments.length) {
      revealedSegments = segments.length;
      root.innerHTML = boundary;
      return false;
    }
    if (reduceMotion) {
      revealedSegments = segments.length;
      root.innerHTML = boundary;
      return false;
    }
    const backlog = segments.length - revealedSegments;
    const chunk = Math.max(1, Math.ceil(backlog / MAX_CATCHUP_STEPS));
    revealedSegments = Math.min(segments.length, revealedSegments + chunk);
    root.innerHTML = segments.slice(0, revealedSegments).join('');
    return revealedSegments < segments.length;
  };
  const schedule = () => {
    if (timer) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = 0;
      if (applyStep()) {
        schedule();
      }
    }, STEP_MS);
  };
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      (typeof parentOrigin === 'string' &&
        parentOrigin.length > 0 &&
        event.origin !== parentOrigin)
    ) {
      return;
    }
    const data = event.data;
    if (
      !data ||
      data.kind !== '${VISUALIZE_STREAM_UPDATE_MESSAGE_KIND}' ||
      typeof data.code !== 'string'
    ) {
      return;
    }
    targetCode = data.code;
    done = data.done === true;
    if (applyStep()) {
      schedule();
    }
  });
})();`,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function buildVisualizeWidgetDocument(
  view: VisualizeWidgetView,
  options: { instant?: boolean } = {},
): string {
  const titleText = view.title ?? 'visualize widget';
  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtmlText(titleText)}</title>`,
    `<style>${VISUALIZE_WIDGET_STYLE}</style>`,
    '</head>',
    '<body>',
    VISUALIZE_WIDGET_SVG_DEFS,
    buildVisualizeWidgetBody(view, options.instant === true),
    '</body>',
    '</html>',
  ].join('\n');
}

// 점진 렌더 — 위젯이 한 번에 뜨지 않고 마크업을 태그 경계 단위로 천천히
// 주입해 화면이 그려지는 과정을 보여준다. 문자 단위로 자르면 태그 중간이
// 잘린 프리픽스가 잠깐 깨진 레이아웃(그리고 프레임 높이 래칫)을 만들므로,
// 항상 유효한 마크업 프리픽스가 되도록 '<' 직전에서만 자른다. innerHTML로
// 넣은 <script>는 실행되지 않으므로, 스크립트를 품은 HTML 조각은 점진 주입
// 대신 문서에 직접 심어 실행 보장을 지킨다. prefers-reduced-motion이면
// 즉시 렌더.
function buildVisualizeWidgetBody(
  view: VisualizeWidgetView,
  instant: boolean,
): string {
  const canStream =
    !instant && (view.mode === 'svg' || !/<script\b/i.test(view.code));
  if (!canStream) {
    return `<div class="geulbat-visualize-root">${view.code}</div>`;
  }
  const escapedCode = JSON.stringify(view.code).replace(/</g, '\\u003C');
  return [
    '<div class="geulbat-visualize-root" id="geulbat-visualize-root"></div>',
    '<script>',
    `(() => {
  const root = document.getElementById('geulbat-visualize-root');
  if (!root) {
    return;
  }
  const code = ${escapedCode};
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    root.innerHTML = code;
    return;
  }
  const segments = code.split(/(?=<)/);
  const total = segments.length;
  const durationMs = Math.max(600, Math.min(2500, total * 45));
  const stepMs = 45;
  const steps = Math.max(1, Math.round(durationMs / stepMs));
  const chunk = Math.max(1, Math.ceil(total / steps));
  let index = 0;
  const tick = () => {
    index = Math.min(total, index + chunk);
    root.innerHTML = segments.slice(0, index).join('');
    if (index < total) {
      window.setTimeout(tick, stepMs);
    }
  };
  tick();
})();`,
    '</script>',
  ].join('\n');
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
