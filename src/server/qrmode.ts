import { randomBytes } from 'node:crypto';
import { PERMANENT_TOKEN_PREFIX } from '../shared/protocol';
import { SCHEMA_VERSION, type LiveEvent, type QrMode, type QrModeView, type Settings } from '../shared/types';
import { hmacB64u, safeEqual } from './crypto';
import type { AuditService } from './domain/audit';
import { PulseError } from './errors';
import type { JsonStore } from './storage/jsonStore';

export interface PermanentQrRecord {
  id: string;
  generation: number;
  createdAt: string;
  createdBy: string;
}

export interface QrModeDoc {
  schemaVersion: number;
  revision: number;
  activeMode: QrMode;
  permanent: PermanentQrRecord | null;
  changedAt: string;
  changedBy: string;
}

export type PermanentVerdict =
  | { ok: true; pid: string; generation: number }
  | { ok: false; code: 'QR_INVALID' | 'QR_EXPIRED' };

export function defaultQrModeDoc(nowIso: string): QrModeDoc {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, activeMode: 'timer', permanent: null, changedAt: nowIso, changedBy: 'system' };
}

export function validateQrModeDoc(raw: unknown): QrModeDoc {
  if (typeof raw !== 'object' || raw === null) throw new Error('qr-mode.json is not an object');
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== SCHEMA_VERSION) throw new Error('qr-mode.json has an unsupported schema version');
  if (!Number.isInteger(r.revision) || (r.revision as number) < 0) throw new Error('qr-mode.json revision is invalid');
  if (r.activeMode !== 'timer' && r.activeMode !== 'permanent') throw new Error('qr-mode.json activeMode must be "timer" or "permanent"');
  let permanent: PermanentQrRecord | null = null;
  if (r.permanent !== null && r.permanent !== undefined) {
    const p = r.permanent as Record<string, unknown>;
    if (typeof p !== 'object' || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(p.id)) throw new Error('qr-mode.json permanent id is invalid');
    if (!Number.isInteger(p.generation) || (p.generation as number) < 1) throw new Error('qr-mode.json permanent generation is invalid');
    if (typeof p.createdAt !== 'string' || typeof p.createdBy !== 'string') throw new Error('qr-mode.json permanent record is incomplete');
    permanent = { id: p.id, generation: p.generation as number, createdAt: p.createdAt, createdBy: p.createdBy };
  }
  if (r.activeMode === 'permanent' && !permanent) throw new Error('qr-mode.json activates the permanent mode without a permanent code');
  if (typeof r.changedAt !== 'string' || typeof r.changedBy !== 'string') throw new Error('qr-mode.json change info is missing');
  return { schemaVersion: SCHEMA_VERSION, revision: r.revision as number, activeMode: r.activeMode, permanent, changedAt: r.changedAt, changedBy: r.changedBy };
}

export class QrModeService {
  constructor(
    private readonly store: JsonStore<QrModeDoc>,
    private readonly key: Buffer,
    private readonly hostId: string,
    private readonly audit: AuditService,
    private readonly now: () => number,
    private readonly emit: (e: LiveEvent) => void,
    private readonly settings: () => Settings,
    private readonly onChanged: () => void,
  ) {}

  activeMode(): QrMode {
    return this.store.data.activeMode;
  }

  view(): QrModeView {
    const d = this.store.data;
    return {
      activeMode: d.activeMode,
      revision: d.revision,
      hasPermanent: !!d.permanent,
      permanentGeneration: d.permanent?.generation ?? 0,
      permanentCreatedAt: d.permanent?.createdAt,
      permanentCreatedBy: d.permanent?.createdBy,
      changedAt: d.changedAt,
      changedBy: d.changedBy,
      rotationSeconds: this.settings().rotationSeconds,
    };
  }

  permanentRecord(): PermanentQrRecord | null {
    return this.store.data.permanent;
  }

  issuePermanentToken(): string | null {
    const p = this.store.data.permanent;
    if (!p) return null;
    const head = `${PERMANENT_TOKEN_PREFIX}.${this.hostId}.${p.id}`;
    return `${head}.${hmacB64u(this.key, head)}`;
  }

  verifyPermanent(token: string): PermanentVerdict {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== PERMANENT_TOKEN_PREFIX || parts[1] !== this.hostId) return { ok: false, code: 'QR_INVALID' };
    const head = parts.slice(0, 3).join('.');
    if (!safeEqual(hmacB64u(this.key, head), parts[3])) return { ok: false, code: 'QR_INVALID' };
    const current = this.store.data.permanent;
    if (!current || current.id !== parts[2]) return { ok: false, code: 'QR_EXPIRED' };
    return { ok: true, pid: current.id, generation: current.generation };
  }

  private checkRevision(doc: QrModeDoc, expected: number | undefined): void {
    if (expected !== undefined && expected !== doc.revision) {
      throw new PulseError('QR_MODE_CONFLICT', 'Another administrator changed the QR code mode just now. The screen has been refreshed; review it and try again.', 409);
    }
  }

  private stamp(doc: QrModeDoc, actor: string): void {
    doc.revision += 1;
    doc.changedAt = new Date(this.now()).toISOString();
    doc.changedBy = actor;
  }

  private newPermanent(actor: string, generation: number): PermanentQrRecord {
    return { id: randomBytes(18).toString('base64url'), generation, createdAt: new Date(this.now()).toISOString(), createdBy: actor };
  }

  async setMode(mode: QrMode, actor: string, expectedRevision?: number): Promise<QrModeView> {
    const outcome = await this.store.update((doc) => {
      this.checkRevision(doc, expectedRevision);
      if (doc.activeMode === mode) return { changed: false, created: false, from: doc.activeMode };
      const from = doc.activeMode;
      let created = false;
      if (mode === 'permanent' && !doc.permanent) {
        doc.permanent = this.newPermanent(actor, 1);
        created = true;
      }
      doc.activeMode = mode;
      this.stamp(doc, actor);
      return { changed: true, created, from };
    });
    if (outcome.changed) {
      await this.audit.record({
        type: 'qr-mode.changed',
        severity: 'notice',
        actor,
        summary: `QR code mode changed from ${outcome.from === 'timer' ? 'Timer-Based' : 'Permanent'} to ${mode === 'timer' ? 'Timer-Based' : 'Permanent'}${outcome.created ? ' (permanent QR code created)' : ''}`,
        details: { from: outcome.from, to: mode, permanentCreated: outcome.created },
      });
      this.onChanged();
    }
    const view = this.view();
    this.emit({ type: 'qr.mode', data: view });
    return view;
  }

  async regeneratePermanent(actor: string, expectedRevision?: number): Promise<QrModeView> {
    const generation = await this.store.update((doc) => {
      this.checkRevision(doc, expectedRevision);
      const next = (doc.permanent?.generation ?? 0) + 1;
      doc.permanent = this.newPermanent(actor, next);
      this.stamp(doc, actor);
      return next;
    });
    await this.audit.record({
      type: 'qr-mode.permanent-regenerated',
      severity: 'notice',
      actor,
      summary: `Permanent QR code regenerated (generation ${generation}); the previous permanent code no longer works`,
      details: { generation },
    });
    this.onChanged();
    const view = this.view();
    this.emit({ type: 'qr.mode', data: view });
    return view;
  }
}
