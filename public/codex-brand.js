// Original Codex Remote Web terminal/window mark, distributed under the project MIT license.
// The function name and data attribute remain stable for existing UI integrations.
export function codexInterfaceMark(className = "") {
  return `<span class="codex-interface-mark${className ? ` ${className}` : ""}" data-codex-interface-mark><svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h12a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5h-5l-5 3v-3H8a5 5 0 0 1-5-5v-6a5 5 0 0 1 5-5Z"/><path d="m9 11 3 3-3 3m7 0h4"/></svg></span>`;
}
