import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import type { NzCompletionItem } from '../../../preload/api';
import { expandSqlShortcut, findSqlShortcut } from '../lib/sqlShortcuts';

// Bundle Monaco locally (no CDN — works offline and inside Electron).
// Must be set before the first editor is created.
if (!(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment) {
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new editorWorker()
  };
}

interface Props {
  value: string;
  running: boolean;
  connected: boolean;
  maxRows: number;
  timeoutSec: number;
  autoLimit: boolean;
  onChange: (v: string) => void;
  onRun: (selection?: string) => void;
  onCancel: () => void;
  setMaxRows: (n: number) => void;
  setTimeoutSec: (n: number) => void;
  setAutoLimit: (b: boolean) => void;
}

const FALLBACK_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'JOIN',
  'ON',
  'GROUP BY',
  'ORDER BY',
  'LIMIT',
  'WITH',
  'AS',
  'CASE',
  'NULL',
  'DISTRIBUTE',
  'RANDOM',
  'HASH',
  'ORGANIZE',
  'EXTERNAL',
  'TABLE',
  'RECLAIM',
  'GROOM',
  'GENERATE',
  'STATISTICS',
  'NZPLSQL'
];

let completionRegistered = false;
function registerNetezzaCompletions(): void {
  if (completionRegistered) return;
  completionRegistered = true;
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' ', '\n'],
    provideCompletionItems: async (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      };
      try {
        const response = await window.nz.completion({ sql: model.getValue(), offset: model.getOffsetAt(position) });
        const items: NzCompletionItem[] = response.items.length > 0
          ? response.items
          : FALLBACK_KEYWORDS.map((label) => ({ label, kind: 'keyword' as const }));
        const kindMap: Record<string, monaco.languages.CompletionItemKind> = {
          keyword: monaco.languages.CompletionItemKind.Keyword,
          database: monaco.languages.CompletionItemKind.Module,
          schema: monaco.languages.CompletionItemKind.Folder,
          table: monaco.languages.CompletionItemKind.Class,
          view: monaco.languages.CompletionItemKind.Interface,
          column: monaco.languages.CompletionItemKind.Field,
          cte: monaco.languages.CompletionItemKind.Struct,
          'temp-table': monaco.languages.CompletionItemKind.Struct,
          alias: monaco.languages.CompletionItemKind.Variable
        };
        return {
          suggestions: items.map((candidate) => ({
            label: candidate.label,
            kind: kindMap[candidate.kind] ?? monaco.languages.CompletionItemKind.Text,
            insertText: candidate.insertText ?? candidate.label,
            detail: candidate.detail,
            sortText: candidate.sortText,
            range
          }))
        };
      } catch {
        return {
          suggestions: FALLBACK_KEYWORDS.map((label) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: label,
            range
          }))
        };
      }
    }
  });
}

export default function SqlEditor(p: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const shortcutApplyingRef = useRef(false);
  const onRunRef = useRef(p.onRun);
  const onChangeRef = useRef(p.onChange);
  const [failed, setFailed] = useState<string | null>(null);
  onRunRef.current = p.onRun;
  onChangeRef.current = p.onChange;

  // Create once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    try {
      registerNetezzaCompletions();
      const editor = monaco.editor.create(el, {
        value: p.value,
        language: 'sql',
        theme: 'vs-dark',
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', monospace",
        padding: { top: 12 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        renderLineHighlight: 'all',
        bracketPairColorization: { enabled: true },
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: 'off',
        acceptSuggestionOnCommitCharacter: false,
        tabCompletion: 'on',
        tabSize: 2,
        automaticLayout: true
      });
      editorRef.current = editor;

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        const model = editor.getModel();
        const sel = editor.getSelection();
        const text = model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : undefined;
        onRunRef.current(text && text.trim() ? text : undefined);
      });

      const sub = editor.onDidChangeModelContent((event) => {
        const model = editor.getModel();
        const change = event.changes.length === 1 ? event.changes[0] : null;
        if (model && !shortcutApplyingRef.current && change && change.text === ' ' && change.rangeLength === 0) {
          const cursorOffset = change.rangeOffset + change.text.length;
          const match = findSqlShortcut(model.getValue(), cursorOffset);
          if (match) {
            shortcutApplyingRef.current = true;
            editor.executeEdits('sql-shortcut', [{
              range: {
                startLineNumber: model.getPositionAt(match.start).lineNumber,
                startColumn: model.getPositionAt(match.start).column,
                endLineNumber: model.getPositionAt(match.end).lineNumber,
                endColumn: model.getPositionAt(match.end).column
              },
              text: match.replacement
            }]);
            editor.setPosition(model.getPositionAt(match.start + match.replacement.length));
            shortcutApplyingRef.current = false;
            if (match.replacement === 'SELECT ' || match.replacement === 'FROM ') {
              window.setTimeout(() => editor.trigger('sql-shortcut', 'editor.action.triggerSuggest', {}), 0);
            }
          }
        }
        onChangeRef.current(editor.getValue());
      });

      const ro = new ResizeObserver(() => editor.layout());
      ro.observe(el);

      return () => {
        ro.disconnect();
        sub.dispose();
        editor.dispose();
        editorRef.current = null;
      };
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value (history restore, schema pick) without echo loops.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getValue() !== p.value) {
      editor.setValue(p.value);
    }
  }, [p.value]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/60 px-3 py-2">
        <button
          onClick={() => p.onRun()}
          disabled={p.running || !p.connected}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        >
          {p.running ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <span>▶</span>}
          {p.running ? 'Running…' : 'Run'}
        </button>
        {p.running && (
          <button
            onClick={p.onCancel}
            className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/20"
          >
            ⏹ Cancel
          </button>
        )}
        <div className="mx-1 hidden h-5 w-px bg-slate-800 sm:block" />
        <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
          Limit
          <input
            type="number"
            min={1}
            max={10000}
            value={p.maxRows}
            onChange={(e) => p.setMaxRows(Math.min(10000, Math.max(1, Number(e.target.value) || 1000)))}
            className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
          Timeout
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={600}
              value={p.timeoutSec}
              onChange={(e) => p.setTimeoutSec(Math.max(0, Number(e.target.value) || 0))}
              className="w-16 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-indigo-500"
            />
            s
          </span>
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400" title="Append LIMIT to simple SELECTs without their own LIMIT">
          <input type="checkbox" checked={p.autoLimit} onChange={(e) => p.setAutoLimit(e.target.checked)} className="accent-emerald-500" />
          auto-LIMIT
        </label>
        {!p.connected && <span className="ml-auto text-[11px] italic text-slate-600">Connect to run queries</span>}
      </div>
      <div className="min-h-0 flex-1">
        {failed ? (
          <textarea
            ref={fallbackRef}
            value={p.value}
            onKeyDown={(event) => {
              if (event.key !== ' ' || event.defaultPrevented) return;
              const target = event.currentTarget;
              if (target.selectionStart !== target.selectionEnd) return;
              const cursorOffset = target.selectionStart + 1;
              const expanded = expandSqlShortcut(`${target.value.slice(0, target.selectionStart)} ${target.value.slice(target.selectionEnd)}`, cursorOffset);
              if (!expanded) return;
              event.preventDefault();
              p.onChange(expanded.value);
              window.requestAnimationFrame(() => fallbackRef.current?.setSelectionRange(expanded.cursorOffset, expanded.cursorOffset));
            }}
            onChange={(e) => p.onChange(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-slate-950 p-3 font-mono text-[13px] text-slate-200 outline-none"
            placeholder={`Editor fallback (Monaco failed: ${failed})`}
          />
        ) : (
          <div ref={containerRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
}
