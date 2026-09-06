import { formatMs } from '../lib/format';

interface Props {
  elapsedMs: number | null;
  rowCount: number | null;
  truncated: boolean;
  autoLimitApplied: boolean;
  noticesCount: number;
  errorCode?: string;
}

export default function StatusBar({ elapsedMs, rowCount, truncated, autoLimitApplied, noticesCount, errorCode }: Props) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-slate-800 bg-slate-900/80 px-3 text-[11px] text-slate-500">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
        {elapsedMs === null ? 'ready' : `time: ${formatMs(elapsedMs)}`}
      </span>
      {rowCount !== null && <span className="font-mono">rows: {rowCount}</span>}
      {truncated && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">truncated to limit</span>}
      {autoLimitApplied && <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-indigo-300">preview limited · Excel = full SQL</span>}
      {noticesCount > 0 && <span className="text-sky-300">notices: {noticesCount}</span>}
      {errorCode && <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-red-300">{errorCode}</span>}
      <span className="ml-auto hidden font-mono text-slate-600 sm:inline">driver: @justybase/netezza-driver · main-process only</span>
    </footer>
  );
}
