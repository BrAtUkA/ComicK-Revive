/**
 * Async facade over the CodeMirror-based JSON editor. The implementation
 * (and CodeMirror itself, ~400KB minified) lives in a dynamically imported
 * chunk so the dashboard doesn't parse it until a spec modal actually opens.
 */

export interface JsonEditor {
  root: HTMLElement;
  get(): string;
  set(text: string): void;
}

export async function createJsonEditor(initial = ''): Promise<JsonEditor> {
  const { createJsonEditorSync } = await import('./jsonEditorCm');
  return createJsonEditorSync(initial);
}
