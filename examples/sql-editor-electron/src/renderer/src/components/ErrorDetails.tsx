import type { NzErrorPayload } from '../../../preload/api';

interface Props {
    error: NzErrorPayload;
}

export default function ErrorDetails({ error }: Props) {
    const diagnostics = Object.entries(error.diagnostics ?? {});

    return (
        <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
                {error.code && (
                    <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-[11px] text-red-300">
                        {error.code}
                    </span>
                )}
                {error.severity && (
                    <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[11px] uppercase text-orange-300">
                        {error.severity}
                    </span>
                )}
                <span>{error.message}</span>
            </div>
            {error.detail && <div className="text-red-300/70">{error.detail}</div>}
            {error.hint && <div className="text-amber-300/70">Hint: {error.hint}</div>}
            {diagnostics.length > 0 && (
                <details className="text-[11px] text-red-300/60">
                    <summary className="cursor-pointer select-none">Backend diagnostics</summary>
                    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 pl-2 font-mono">
                        {diagnostics.map(([field, value]) => (
                            <div key={field} className="contents">
                                <dt className="text-red-300/40">{field}</dt>
                                <dd className="break-words">{value}</dd>
                            </div>
                        ))}
                    </dl>
                </details>
            )}
        </div>
    );
}
