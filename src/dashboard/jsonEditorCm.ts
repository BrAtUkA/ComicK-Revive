/**
 * JSON editor built on CodeMirror 6 (bundled, no CDN, MV3-safe). Replaces
 * two generations of hand-rolled textarea overlays whose caret/highlight
 * layers could never be kept in perfect sync. CodeMirror gives us a real
 * caret, line numbers, folding, bracket matching, auto-pairing, search
 * (Ctrl+F), undo history, and inline lint squiggles from JSON.parse.
 *
 * The status bar below the editor is ours: caret position, live validity
 * (click an error to jump to it), and a Format action.
 */

import { basicSetup } from 'codemirror';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import { tags } from '@lezer/highlight';

import type { JsonEditor } from './jsonEditor';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--crd-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--crd-ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--crd-ink)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(99, 102, 241, 0.16)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'rgba(99, 102, 241, 0.28)',
  },
  '.cm-gutters': {
    backgroundColor: 'rgba(255, 255, 255, 0.015)',
    color: 'var(--crd-ink-3)',
    border: 'none',
    borderRight: '1px solid var(--crd-line)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--crd-accent-2)' },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.025)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(99, 102, 241, 0.28)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'rgba(99, 102, 241, 0.14)',
    border: 'none',
    borderRadius: '5px',
    color: 'var(--crd-accent-2)',
    padding: '0 7px',
    margin: '0 4px',
  },
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer' },
  '.cm-tooltip': {
    backgroundColor: '#17171d',
    border: '1px solid var(--crd-line-2)',
    color: 'var(--crd-ink)',
    borderRadius: '8px',
  },
  '.cm-panels': {
    backgroundColor: 'var(--crd-panel)',
    color: 'var(--crd-ink)',
    borderTop: '1px solid var(--crd-line)',
  },
  '.cm-panel input, .cm-panel button, .cm-panel label': { fontFamily: 'var(--crd-mono)', fontSize: '11px' },
  '.cm-searchMatch': { backgroundColor: 'rgba(99, 102, 241, 0.25)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(99, 102, 241, 0.5)' },
}, { dark: true });

const jsonHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: '#93c5fd' },
  { tag: tags.string, color: '#86efac' },
  { tag: tags.number, color: '#fca5a5' },
  { tag: tags.bool, color: '#c4b5fd' },
  { tag: tags.null, color: '#c4b5fd' },
  { tag: tags.punctuation, color: 'var(--crd-ink-2)' },
  { tag: tags.invalid, color: '#f87171' },
]);

export function createJsonEditorSync(initial = ''): JsonEditor {
  const root = document.createElement('div');
  root.className = 'crd-jsed';
  root.innerHTML = `
    <div class="crd-jsed-cm"></div>
    <div class="crd-jsed-bar">
      <span class="crd-jsed-pos">Ln 1, Col 1</span>
      <button type="button" class="crd-jsed-state" tabindex="-1"></button>
      <span class="crd-jsed-spacer"></span>
      <button type="button" class="crd-jsed-format" tabindex="-1" title="Pretty-print with 2-space indent">Format</button>
    </div>
  `;
  const mount = root.querySelector<HTMLElement>('.crd-jsed-cm')!;
  const posEl = root.querySelector<HTMLElement>('.crd-jsed-pos')!;
  const stateEl = root.querySelector<HTMLButtonElement>('.crd-jsed-state')!;
  const formatBtn = root.querySelector<HTMLButtonElement>('.crd-jsed-format')!;

  const renderPos = (state: EditorState) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    posEl.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
  };

  // ── Live validity in the status bar (lint squiggles cover the exact
  // range; this gives the at-a-glance verdict and a jump target) ──────────
  let errorPos = -1;
  let vTimer: ReturnType<typeof setTimeout> | null = null;
  const validate = () => {
    const src = view.state.doc.toString();
    errorPos = -1;
    if (!src.trim()) {
      stateEl.className = 'crd-jsed-state';
      stateEl.textContent = '';
      return;
    }
    try {
      JSON.parse(src);
      stateEl.className = 'crd-jsed-state ok';
      stateEl.innerHTML = `<span class="dot"></span>Valid JSON`;
      stateEl.title = '';
    } catch (error) {
      const msg = (error as Error).message;
      const loc = locateJsonError(msg, src);
      errorPos = loc?.pos ?? -1;
      const short = msg.split(' in JSON')[0].replace(/^JSON\.parse:\s*/, '');
      stateEl.className = 'crd-jsed-state err';
      stateEl.innerHTML = `<span class="dot"></span>${loc ? `Line ${loc.line}: ` : ''}${escapeHtml(short)}`;
      stateEl.title = loc ? 'Click to jump to the error' : msg;
    }
  };
  const scheduleValidate = () => {
    if (vTimer) clearTimeout(vTimer);
    vTimer = setTimeout(validate, 250);
  };

  const view = new EditorView({
    parent: mount,
    doc: initial,
    extensions: [
      basicSetup,
      json(),
      linter(jsonParseLinter()),
      lintGutter(),
      indentUnit.of('  '),
      keymap.of([indentWithTab]),
      placeholder('{"spec": 1, "id": "mysource", ...}'),
      theme,
      syntaxHighlighting(jsonHighlight),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) renderPos(update.state);
        if (update.docChanged) scheduleValidate();
      }),
    ],
  });

  stateEl.addEventListener('click', () => {
    if (errorPos < 0) return;
    const pos = Math.min(errorPos, view.state.doc.length);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  });

  formatBtn.addEventListener('click', () => {
    try {
      const formatted = JSON.stringify(JSON.parse(view.state.doc.toString()), null, 2);
      if (formatted !== view.state.doc.toString()) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: formatted },
          selection: { anchor: 0 },
          scrollIntoView: true,
        });
      }
      view.focus();
    } catch {
      validate();
    }
  });

  renderPos(view.state);
  validate();

  return {
    root,
    get: () => view.state.doc.toString(),
    set: (text: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
      validate();
    },
  };
}

/** Pull a caret position out of a V8 JSON.parse error message */
function locateJsonError(msg: string, src: string): { line: number; col: number; pos: number } | null {
  const lineCol = msg.match(/\(line (\d+) column (\d+)\)/);
  if (lineCol) {
    const line = parseInt(lineCol[1], 10);
    const col = parseInt(lineCol[2], 10);
    let pos = 0;
    for (let i = 1; i < line; i++) pos = src.indexOf('\n', pos) + 1;
    return { line, col, pos: pos + col - 1 };
  }
  const position = msg.match(/at position (\d+)/);
  if (position) {
    const pos = Math.min(parseInt(position[1], 10), src.length);
    const before = src.slice(0, pos);
    return { line: before.split('\n').length, col: pos - before.lastIndexOf('\n'), pos };
  }
  return null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
