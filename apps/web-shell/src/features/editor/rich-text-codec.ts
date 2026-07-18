// 리치 에디터 왕복 코덱 — 지원 서식을 4가지(굵게/기울임/밑줄/글자색)로
// 한정해 markdown ↔ HTML 왕복 안전성을 보장한다. 그 외 텍스트는 전부
// escape되어 그대로 보존된다. 전체 rich 문서 모델은 P8 owner.

const COLOR_SPAN_PATTERN =
  /^<span style="color:(#[0-9a-fA-F]{3,8})">([\s\S]*?)<\/span>/;
const FONT_SIZE_SPAN_PATTERN =
  /^<span style="font-size:(\d{1,3})px">([\s\S]*?)<\/span>/;
const ALIGN_DIV_PATTERN =
  /^<div style="text-align:(left|center|right|justify)">([\s\S]*?)<\/div>/;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 서식/개행이 시작될 수 있는 문자 — 그 사이의 평문 구간은 통째로
// escape해서 붙인다 (문자 단위 루프는 대형 문서에서 수백 ms).
const RICH_TOKEN_START = /[*<\n&>]/;

// markdown(제한 문법) → contentEditable용 HTML
export function richMarkdownToHtml(source: string, depth = 0): string {
  if (depth > 8) {
    return escapeHtml(source);
  }
  let html = '';
  let rest = source;
  while (rest.length > 0) {
    const tokenIndex = rest.search(RICH_TOKEN_START);
    if (tokenIndex === -1) {
      html += escapeHtml(rest);
      break;
    }
    if (tokenIndex > 0) {
      html += escapeHtml(rest.slice(0, tokenIndex));
      rest = rest.slice(tokenIndex);
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold?.[1] !== undefined) {
      html += `<strong>${richMarkdownToHtml(bold[1], depth + 1)}</strong>`;
      rest = rest.slice(bold[0].length);
      continue;
    }
    const italic = /^\*([^*\n]+)\*/.exec(rest);
    if (italic?.[1] !== undefined) {
      html += `<em>${richMarkdownToHtml(italic[1], depth + 1)}</em>`;
      rest = rest.slice(italic[0].length);
      continue;
    }
    const underline = /^<u>([\s\S]*?)<\/u>/.exec(rest);
    if (underline?.[1] !== undefined) {
      html += `<u>${richMarkdownToHtml(underline[1], depth + 1)}</u>`;
      rest = rest.slice(underline[0].length);
      continue;
    }
    const color = COLOR_SPAN_PATTERN.exec(rest);
    if (color?.[1] !== undefined && color[2] !== undefined) {
      html += `<span style="color:${color[1]}">${richMarkdownToHtml(color[2], depth + 1)}</span>`;
      rest = rest.slice(color[0].length);
      continue;
    }
    const fontSize = FONT_SIZE_SPAN_PATTERN.exec(rest);
    if (fontSize?.[1] !== undefined && fontSize[2] !== undefined) {
      html += `<span style="font-size:${fontSize[1]}px">${richMarkdownToHtml(fontSize[2], depth + 1)}</span>`;
      rest = rest.slice(fontSize[0].length);
      continue;
    }
    // 정렬 블록 — div 자체가 줄을 만들므로 직전 개행은 블록에 흡수한다
    // (왕복 시 빈 줄이 불어나는 drift 방지)
    const alignSource = rest.startsWith('\n') ? rest.slice(1) : rest;
    const align = ALIGN_DIV_PATTERN.exec(alignSource);
    if (align?.[1] !== undefined && align[2] !== undefined) {
      html += `<div style="text-align:${align[1]}">${richMarkdownToHtml(align[2], depth + 1)}</div>`;
      rest = alignSource.slice(align[0].length);
      // 뒤따르는 개행도 흡수 — 다음 줄은 어차피 블록 경계에서 시작한다
      if (rest.startsWith('\n')) {
        rest = rest.slice(1);
      }
      continue;
    }
    const char = rest[0]!;
    html += char === '\n' ? '<br>' : escapeHtml(char);
    rest = rest.slice(1);
  }
  return html;
}

// contentEditable DOM → markdown(제한 문법). 지원 외 태그는 텍스트만 보존.
export function richHtmlToMarkdown(root: Node): string {
  return serializeChildren(root).replace(/^\n/, '');
}

function serializeChildren(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    out += serializeNode(child);
  });
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  if (!(node instanceof HTMLElement)) {
    return serializeChildren(node);
  }
  const element = node;
  const tag = element.tagName.toLowerCase();
  const inner = serializeChildren(element);
  switch (tag) {
    case 'br':
      return '\n';
    case 'strong':
    case 'b':
      return inner.trim() ? `**${inner}**` : inner;
    case 'em':
    case 'i':
      return inner.trim() ? `*${inner}*` : inner;
    case 'u':
      return inner.trim() ? `<u>${inner}</u>` : inner;
    case 'div':
    case 'p': {
      // contentEditable이 줄을 div로 감싼다 — 블록은 새 줄에서 시작.
      // 정렬이 걸린 블록은 text-align div로 보존한다.
      const textAlign = element.style.textAlign;
      if (
        textAlign === 'left' ||
        textAlign === 'center' ||
        textAlign === 'right' ||
        textAlign === 'justify'
      ) {
        return `\n<div style="text-align:${textAlign}">${inner}</div>`;
      }
      return `\n${inner}`;
    }
    case 'span':
    case 'font': {
      const color =
        element.style.color !== ''
          ? normalizeColor(element.style.color)
          : element.getAttribute('color');
      const fontSize = /^(\d{1,3})px$/.exec(element.style.fontSize)?.[1];
      let wrapped = inner;
      if (fontSize && wrapped.trim()) {
        wrapped = `<span style="font-size:${fontSize}px">${wrapped}</span>`;
      }
      if (color && wrapped.trim()) {
        wrapped = `<span style="color:${color}">${wrapped}</span>`;
      }
      return wrapped;
    }
    default:
      return inner;
  }
}

// rgb(r, g, b) → #rrggbb (execCommand foreColor가 rgb로 저장하는 브라우저 대응)
function normalizeColor(cssColor: string): string | null {
  const trimmed = cssColor.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
    return trimmed;
  }
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(trimmed);
  if (!rgb) {
    return null;
  }
  const toHex = (value: string) => Number(value).toString(16).padStart(2, '0');
  return `#${toHex(rgb[1]!)}${toHex(rgb[2]!)}${toHex(rgb[3]!)}`;
}
