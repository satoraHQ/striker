import QRCode from 'qrcode';
import { useEffect, useState, type ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-line bg-panel p-4 sm:p-5 ${className}`}>{children}</section>;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:bg-white/5 active:bg-white/10"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* clipboard blocked */ }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Qr({ text, size = 240 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: size * 2, errorCorrectionLevel: 'M' })
      .then((u) => { if (live) setSrc(u); }).catch(() => setSrc(undefined));
    return () => { live = false; };
  }, [text, size]);
  return (
    <div className="mx-auto rounded-xl bg-white p-2" style={{ width: size + 16, height: size + 16 }}>
      {src && <img src={src} width={size} height={size} alt="Deposit address QR code" />}
    </div>
  );
}

export function Row({ label, children, strong }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className={`text-right tabular-nums ${strong ? 'font-semibold text-white' : 'text-slate-200'}`}>{children}</span>
    </div>
  );
}

export function Seg<T extends string | number>({ value, options, onChange }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-xl bg-black/30 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-lg px-2 py-1.5 text-sm font-medium transition ${value === o.value ? 'bg-accent text-slate-900' : 'text-slate-300 hover:text-white'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const STATUS_STYLE: Record<string, string> = {
  awaiting_deposit: 'bg-sky-500/15 text-sky-300',
  deposited: 'bg-amber-500/15 text-amber-300',
  filled: 'bg-emerald-500/15 text-emerald-300',
  refunding: 'bg-orange-500/15 text-orange-300',
  refunded: 'bg-slate-500/20 text-slate-300',
  expired: 'bg-slate-500/20 text-slate-400',
  failed: 'bg-red-500/15 text-red-300',
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? 'bg-white/10'}`}>{status.replace('_', ' ')}</span>;
}

export const short = (s: string, n = 8) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
