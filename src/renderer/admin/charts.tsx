import type { DayRecord, OverviewCounts } from '../../shared/types';

export function Donut({ counts }: { counts: OverviewCounts }) {
  const parts = [
    { label: 'On time', value: counts.onTime, color: '#1f9d63' },
    { label: 'Grace', value: counts.grace, color: '#e6b800' },
    { label: 'Late', value: counts.late, color: '#d4101f' },
    { label: 'Pending', value: counts.pending, color: '#9a9aa5' },
    { label: 'Absent', value: counts.absent, color: '#3a3a44' },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="chart-donut">
      <svg width="148" height="148" viewBox="0 0 148 148" role="img" aria-label="Attendance split">
        <circle cx="74" cy="74" r={R} fill="none" stroke="#f1f1f3" strokeWidth="16" />
        {total > 0 &&
          parts.map((p) => {
            const len = (p.value / total) * C;
            const el = p.value ? <circle key={p.label} cx="74" cy="74" r={R} fill="none" stroke={p.color} strokeWidth="16" strokeDasharray={`${Math.max(len - 2, 0)} ${C}`} strokeDashoffset={-offset} transform="rotate(-90 74 74)" strokeLinecap="butt" /> : null;
            offset += len;
            return el;
          })}
        <text x="74" y="72" textAnchor="middle" fontSize="26" fontWeight="700" fill="#111114">
          {total ? Math.round((counts.present / Math.max(total, 1)) * 100) : 0}%
        </text>
        <text x="74" y="92" textAnchor="middle" fontSize="11" fill="#6b6b76">
          arrived
        </text>
      </svg>
      <div className="legend">
        {parts.map((p) => (
          <div key={p.label}>
            <i style={{ background: p.color }} />
            {p.label}
            <b>{p.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Arrivals per 15-minute slot around the start of the working day. */
export function ArrivalsChart({ rows, workStart }: { rows: DayRecord[]; workStart: string }) {
  const [h, m] = workStart.split(':').map(Number);
  const start = h * 60 + m - 60;
  const slots = 12; // start-60 … start+120
  const buckets = Array.from({ length: slots }, (_, i) => ({ label: fmt(start + i * 15), n: 0, late: false }));
  let before = 0;
  let after = 0;
  for (const r of rows) {
    if (!r.checkInLocal) continue;
    const [hh, mm] = r.checkInLocal.split(':').map(Number);
    const idx = Math.floor((hh * 60 + mm - start) / 15);
    if (idx < 0) before++;
    else if (idx >= slots) after++;
    else {
      buckets[idx].n++;
      buckets[idx].late = r.status === 'late' && buckets[idx].late !== false ? true : buckets[idx].late;
    }
  }
  buckets[0].n += before;
  buckets[slots - 1].n += after;
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const startIdx = (h * 60 + m - start) / 15;
  return (
    <div className="bars" role="img" aria-label="Arrivals by time">
      {buckets.map((b, i) => (
        <div key={i} className={`b ${i > startIdx + 0 && b.n ? 'late' : ''}`}>
          <em>{b.n || ''}</em>
          <i style={{ height: `${(b.n / max) * 100}%` }} />
          <span>{i % 2 === 0 ? b.label : ''}</span>
        </div>
      ))}
    </div>
  );
}

function fmt(min: number): string {
  const x = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

export function Heartbeat({ size = 22, color = '#d4101f' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 13h4l2.5-7 4 13 3-9 1.5 3H22" />
    </svg>
  );
}
