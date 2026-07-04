/**
 * Minimal JSON editor with syntax highlighting: a colored <pre> behind a
 * transparent-text <textarea>, kept in sync on input/scroll. No dependencies.
 */

export interface JsonEditor {
  root: HTMLElement;
  get(): string;
  set(text: string): void;
}

export function createJsonEditor(initial = ''): JsonEditor {
  const root = document.createElement('div');
  root.className = 'crd-jsed';
  root.innerHTML = `
    <pre class="crd-jsed-hl" aria-hidden="true"><code></code></pre>
    <textarea class="crd-jsed-ta" spellcheck="false" autocomplete="off"
      placeholder='{"spec": 1, "id": "mysource", ...}'></textarea>
  `;
  const code = root.querySelector<HTMLElement>('code')!;
  const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
  const highlightLayer = root.querySelector<HTMLElement>('.crd-jsed-hl')!;

  const render = () => {
    // Trailing newline keeps the pre's scroll height matching the textarea's
    code.innerHTML = highlightJson(textarea.value) + '\n';
  };
  textarea.addEventListener('input', render);
  textarea.addEventListener('scroll', () => {
    highlightLayer.scrollTop = textarea.scrollTop;
    highlightLayer.scrollLeft = textarea.scrollLeft;
  });

  textarea.value = initial;
  render();

  return {
    root,
    get: () => textarea.value,
    set: (text: string) => {
      textarea.value = text;
      render();
    },
  };
}

const TOKEN_REGEX = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function escapePart(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightJson(src: string): string {
  let out = '';
  let last = 0;
  for (const match of src.matchAll(TOKEN_REGEX)) {
    out += escapePart(src.slice(last, match.index));
    const [, str, colon, literal, num] = match;
    if (str !== undefined) {
      const cls = colon !== undefined ? 'k' : 's';
      out += `<i class="${cls}">${escapePart(str)}</i>${colon !== undefined ? escapePart(colon) : ''}`;
    } else if (literal !== undefined) {
      out += `<i class="l">${literal}</i>`;
    } else if (num !== undefined) {
      out += `<i class="n">${num}</i>`;
    }
    last = match.index! + match[0].length;
  }
  return out + escapePart(src.slice(last));
}
