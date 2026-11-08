import { AlertTriangle, CheckCircle2, Search, X } from 'lucide-react';
import type { ApprovalStatus } from '../../shared/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export function Logo({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img className={`logo-img ${className}`} src="./pulse-icon.png" width={size} height={size} alt="PULSE" draggable={false} />;
}

export function Button({ variant, size, block, loading, className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost' | 'mint'; size?: 'sm'; block?: boolean; loading?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || loading} className={`btn ${variant ?? ''} ${size ?? ''} ${block ? 'block' : ''} ${className}`}>
      {loading ? <span className="spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Card({ title, sub, action, children, pad = true, className = '' }: { title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; pad?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title ? (
        <div className="card-h">
          <div>
            <h2>{title}</h2>
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          <div className="right row">{action}</div>
        </div>
      ) : null}
      <div className={pad ? 'card-b' : ''} style={!title && pad ? { paddingTop: 20 } : undefined}>
        {children}
      </div>
    </section>
  );
}

export function Stat({ label, value, note, tone, icon }: { label: string; value: ReactNode; note?: ReactNode; tone: 'blue' | 'mint' | 'amber' | 'yellow' | 'rose' | 'grey' | 'navy'; icon: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-ico tone-${tone}`}>{icon}</span>
      </div>
      <div className="stat-val">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

export function Chip({ tone, children, icon }: { tone: 'mint' | 'amber' | 'yellow' | 'rose' | 'orange' | 'blue' | 'grey' | 'navy'; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`chip ${tone}`}>
      {icon}
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="search">
      <Search size={16} />
      <input className="input" value={value} placeholder={placeholder ?? 'Search…'} onChange={(e) => onChange(e.target.value)} aria-label={placeholder ?? 'Search'} />
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h">
          <h3>{title}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-b">{children}</div>
        {footer ? <div className="modal-f">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <b>{title}</b>
      <div>{children}</div>
    </div>
  );
}

export function Banner({ tone, title, children, action }: { tone: 'bad' | 'warn' | 'info'; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role="alert">
      <AlertTriangle size={18} style={{ flex: 'none', marginTop: 2 }} />
      <div className="grow">
        <b>{title}</b>
        {children}
      </div>
      {action}
    </div>
  );
}

// ───────────── toasts ─────────────
interface Toast {
  id: number;
  kind: 'ok' | 'err';
  text: string;
}
const ToastCtx = createContext<{ ok: (t: string) => void; err: (t: string) => void }>({ ok: () => undefined, err: () => undefined });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 3500);
  }, []);
  const api = useMemo(() => ({ ok: (t: string) => push('ok', t), err: (t: string) => push('err', t) }), [push]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'ok' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Runs an async action with loading state and toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (okText) toast.ok(okText);
        return r;
      } catch (e) {
        toast.err((e as Error).message);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ───────────── formatting ─────────────
export const hm = (t?: string) => (t ? t.slice(0, 5) : '—');
export function mins(m: number): string {
  if (!m) return '—';
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
export function when(iso?: string, withDate = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return withDate ? `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${t}` : t;
}
export function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? '').slice(0, 2).join('');
}
export function ago(iso?: string): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function ApprovalChip({ status }: { status: ApprovalStatus }) {
  const map: Record<ApprovalStatus, ['mint' | 'amber' | 'rose' | 'grey', string]> = {
    pending: ['amber', 'Awaiting approval'],
    approved: ['mint', 'Approved'],
    rejected: ['rose', 'Rejected'],
    voided: ['grey', 'Voided'],
  };
  const [tone, label] = map[status];
  return <Chip tone={tone}>{label}</Chip>;
}

export type ClassValue = 'on-time' | 'grace' | 'late' | 'very-late' | 'off-day' | string | undefined;

export function classTone(c: ClassValue): { tone: 'mint' | 'yellow' | 'rose' | 'grey'; label: string } | null {
  switch (c) {
    case 'on-time': return { tone: 'mint', label: 'On time' };
    case 'grace': return { tone: 'yellow', label: 'Grace' };
    case 'late':
    case 'very-late': return { tone: 'rose', label: 'Late' };
    case 'off-day': return { tone: 'grey', label: 'Off day' };
    default: return null;
  }
}

export function ClassChip({ value }: { value: ClassValue }) {
  const t = classTone(value);
  if (!t) return null;
  return <Chip tone={t.tone} icon={t.tone === 'grey' ? undefined : <i className="cdot" />}>{t.label}</Chip>;
}

export function StatusChip({ status, classification, early, missing, overtime, approvalPending }: { status: string; classification?: ClassValue; early?: boolean; missing?: boolean; overtime?: ApprovalStatus; approvalPending?: boolean }) {
  const map: Record<string, ['mint' | 'amber' | 'rose' | 'orange' | 'blue' | 'grey', string]> = {
    absent: ['rose', 'Absent'],
    pending: ['blue', 'Pending'],
    'off-day': ['grey', 'Off day'],
  };
  const arrival = status === 'present' || status === 'late' ? classTone(classification) : null;
  const fallback = map[status] ?? (status === 'late' ? ['rose', 'Late'] : status === 'present' ? ['mint', 'On time'] : ['grey', status]);
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {arrival ? <ClassChip value={classification} /> : <Chip tone={fallback[0]}>{fallback[1]}</Chip>}
      {early ? <Chip tone="rose">Left early</Chip> : null}
      {overtime === 'pending' ? <Chip tone="amber">Overtime pending</Chip> : overtime === 'approved' ? <Chip tone="mint">Overtime approved</Chip> : overtime === 'rejected' ? <Chip tone="grey">Overtime rejected</Chip> : null}
      {approvalPending && overtime !== 'pending' ? <Chip tone="blue">Awaiting approval</Chip> : null}
      {missing ? <Chip tone="rose">No check-out</Chip> : null}
    </span>
  );
}
