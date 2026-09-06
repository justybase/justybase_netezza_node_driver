import { useEffect, useState } from 'react';

interface Profile {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

interface Props {
  open: boolean;
  initial: { host: string; port: number; database: string; user: string };
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (p: { host: string; port: number; database: string; user: string; password: string; uri?: string }) => void;
}

const LS_PROFILES = 'nz-profiles-v1';

function loadProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(LS_PROFILES);
    return raw ? (JSON.parse(raw) as Profile[]) : [];
  } catch {
    return [];
  }
}

export default function ConnectionDialog({ open, initial, busy, error, onClose, onSubmit }: Props) {
  const [mode, setMode] = useState<'form' | 'uri'>('form');
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(initial.port);
  const [database, setDatabase] = useState(initial.database);
  const [user, setUser] = useState(initial.user);
  const [password, setPassword] = useState('');
  const [uri, setUri] = useState('');
  const [remember, setRemember] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);

  useEffect(() => {
    if (open) {
      setProfiles(loadProfiles());
      setHost(initial.host);
      setPort(initial.port);
      setDatabase(initial.database);
      setUser(initial.user);
    }
  }, [open, initial]);

  if (!open) return null;

  const saveProfile = (p: Profile) => {
    const next = [p, ...loadProfiles().filter((x) => x.name !== p.name)].slice(0, 10);
    localStorage.setItem(LS_PROFILES, JSON.stringify(next));
    setProfiles(next);
  };

  const submit = () => {
    if (mode === 'uri') {
      if (!uri.trim()) return;
      onSubmit({ host, port, database, user, password, uri: uri.trim() });
      return;
    }
    const p = { host: host.trim(), port: Number(port) || 5480, database: database.trim(), user: user.trim(), password };
    if (!p.host || !p.database || !p.user) return;
    if (remember) saveProfile({ name: `${p.user}@${p.host}/${p.database}`, ...p, password: undefined as never } as Profile);
    onSubmit(p);
  };

  const input =
    'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-800 bg-gradient-to-r from-indigo-500/10 to-cyan-400/10 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">Connect to Netezza</h2>
          <p className="mt-0.5 text-xs text-slate-400">The session lives in the main (Node) process — the renderer only calls IPC.</p>
          <div className="mt-3 flex rounded-lg bg-slate-950 p-1 text-xs font-medium">
            {(['form', 'uri'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md px-3 py-1.5 transition ${mode === m ? 'bg-slate-800 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}
              >
                {m === 'form' ? 'Host / database' : 'URI netezza://'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          {mode === 'form' ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Host</label>
                  <input className={input} value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.0.144" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Port</label>
                  <input className={input} value={port} onChange={(e) => setPort(Number(e.target.value))} type="number" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Database</label>
                  <input className={input} value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="JUST_DATA" />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">User</label>
                  <input className={input} value={user} onChange={(e) => setUser(e.target.value)} placeholder="admin" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Password</label>
                <input className={input} value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="••••••••" />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-indigo-500" />
                Remember profile (without password — demo only)
              </label>
            </>
          ) : (
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Connection string</label>
              <input
                className={`${input} font-mono text-xs`}
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="netezza://admin:***@192.168.0.144:5480/JUST_DATA"
                spellCheck={false}
              />
            </div>
          )}

          {profiles.length > 0 && mode === 'form' && (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Saved</div>
              <div className="flex flex-wrap gap-1.5">
                {profiles.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => {
                      setHost(p.host);
                      setPort(p.port);
                      setDatabase(p.database);
                      setUser(p.user);
                    }}
                    className="rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1 font-mono text-[11px] text-slate-300 transition hover:border-indigo-500/50 hover:text-white"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 bg-slate-950/60 px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-slate-200">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:bg-indigo-400 disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
