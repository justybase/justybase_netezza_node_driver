interface Props {
  connected: boolean;
  info: { host: string; database: string; user: string; port: number } | null;
  running: boolean;
  operationLabel?: string;
  onCancelOperation?: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenSql: () => void;
  onSaveSql: () => void;
  onSaveSqlAs: () => void;
  onImport: () => void;
}

export default function TopBar({ connected, info, running, operationLabel, onCancelOperation, onConnect, onDisconnect, onOpenSql, onSaveSql, onSaveSqlAs, onImport }: Props) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-900/80 px-4 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white shadow-lg shadow-indigo-500/20">
          N
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight text-slate-100">Netezza SQL Editor</div>
          <div className="text-[11px] text-slate-500">example for @justybase/netezza-driver</div>
        </div>
      </div>

      <div className="mx-2 h-6 w-px bg-slate-800" />

      {connected && info ? (
        <div className="flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 py-1 pl-2.5 pr-1.5 text-xs">
          <span className={`h-2 w-2 rounded-full ${running ? 'animate-pulse bg-amber-400' : 'bg-emerald-400'}`} />
          <span className="font-mono text-emerald-200">
            {info.user}@{info.host}:{info.port}/{info.database}
          </span>
          <button
            onClick={onDisconnect}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-emerald-300/80 transition hover:bg-emerald-500/20 hover:text-emerald-100"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-800/60 py-1 pl-2.5 pr-1.5 text-xs text-slate-400">
          <span className="h-2 w-2 rounded-full bg-slate-600" />
          <span>offline — not connected</span>
          <button
            onClick={onConnect}
            className="rounded-full bg-indigo-500 px-2.5 py-0.5 text-[11px] font-semibold text-white transition hover:bg-indigo-400"
          >
            Connect
          </button>
        </div>
      )}

      <button
        onClick={onOpenSql}
        className="rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
      >
        Open SQL
      </button>
      <button
        onClick={onSaveSql}
        className="rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
      >
        Save
      </button>
      <button
        onClick={onSaveSqlAs}
        className="rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
      >
        Save as
      </button>
      <button
        onClick={onImport}
        className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-200 transition hover:border-cyan-400/60 hover:bg-cyan-500/20"
      >
        ⇧ Import
      </button>

      {operationLabel && onCancelOperation && (
        <button
          onClick={onCancelOperation}
          className="rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/20"
        >
          ⏹ Cancel {operationLabel}
        </button>
      )}

      <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
        <span className="hidden rounded-md border border-slate-800 bg-slate-900 px-2 py-1 font-mono md:inline">
          Ctrl/⌘ + Enter = run
        </span>
        <a
          className="rounded-md px-2 py-1 transition hover:bg-slate-800 hover:text-slate-300"
          href="https://github.com/justybase/justybase_netezza_node_driver"
          target="_blank"
          rel="noreferrer"
        >
          driver ↗
        </a>
      </div>
    </header>
  );
}
