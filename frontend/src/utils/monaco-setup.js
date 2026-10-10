import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/**
 * Use the bundled `monaco-editor` package instead of @monaco-editor/react's
 * default, which downloads Monaco from a CDN at runtime.
 *
 * This is required, not cosmetic: `y-monaco` imports `monaco-editor` itself, and
 * the binding only works if it and the editor share *one* Monaco instance (same
 * `Range`/`Selection` classes, same model registry). It also means no
 * third-party script origin, which keeps a strict Content-Security-Policy
 * possible (Phase 11).
 *
 * Monaco runs language services in web workers; Vite's `?worker` imports
 * bundle each one and this tells Monaco which to start for which language.
 */
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

loader.config({ monaco });
