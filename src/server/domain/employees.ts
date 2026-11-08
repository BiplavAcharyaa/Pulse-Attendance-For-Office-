import { z } from 'zod';
import type { Employee, LiveEvent } from '../../shared/types';
import { PulseError } from '../errors';
import { employeeIdSchema, formatZodError, fullNameSchema, phoneSchema, type EmployeesFile } from '../schemas';
import type { JsonStore } from '../storage/jsonStore';
import type { AuditService } from './audit';

export const MAX_EMPLOYEES = 500;

const createSchema = z.object({
  id: employeeIdSchema,
  fullName: fullNameSchema,
  phone: phoneSchema,
  department: z.string().trim().max(60).default(''),
});

const updateSchema = z
  .object({
    fullName: fullNameSchema,
    phone: phoneSchema,
    department: z.string().trim().max(60),
  })
  .partial()
  .strict();

export function normalizeName(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',' || c === '\t' || c === ';') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export class EmployeeService {
  constructor(
    private readonly store: JsonStore<EmployeesFile>,
    private readonly audit: AuditService,
    private readonly emit: (e: LiveEvent) => void,
    private readonly now: () => number,
  ) {}

  list(): Employee[] {
    return [...this.store.data.employees].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  get(id: string): Employee | undefined {
    const k = id.toLowerCase();
    return this.store.data.employees.find((e) => e.id.toLowerCase() === k);
  }

  require(id: string): Employee {
    const e = this.get(id);
    if (!e) throw new PulseError('EMPLOYEE_NOT_FOUND', `Employee ${id} was not found`, 404);
    return e;
  }

  async create(input: unknown, actor: string): Promise<Employee> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const v = parsed.data;
    const nowIso = new Date(this.now()).toISOString();
    const emp: Employee = {
      id: v.id,
      fullName: v.fullName,
      phone: v.phone,
      department: v.department,
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.store.update((d) => {
      const dup = d.employees.find((e) => e.id.toLowerCase() === emp.id.toLowerCase());
      if (dup) {
        throw new PulseError('DUPLICATE_EMPLOYEE', `Employee ID ${emp.id} already exists${dup.archivedAt ? ' in the archive. Restore that employee instead' : ''}`, 409);
      }
      if (d.employees.length >= MAX_EMPLOYEES) throw new PulseError('LIMIT', `Employee limit (${MAX_EMPLOYEES}) reached`, 409);
      d.employees.push(emp);
    });
    await this.audit.record({ type: 'employee.created', actor, summary: `Employee ${emp.id} (${emp.fullName}) created`, details: { employeeId: emp.id } });
    this.emit({ type: 'employee.changed', data: { employeeId: emp.id } });
    return emp;
  }

  async update(id: string, patch: unknown, actor: string): Promise<Employee> {
    const parsed = updateSchema.safeParse(patch);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const cur = this.require(id);
    if (cur.archivedAt) throw new PulseError('ARCHIVED', 'This employee is archived. Restore the employee before editing.', 409);
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update((d) => {
      const e = d.employees.find((x) => x.id === cur.id)!;
      Object.assign(e, parsed.data, { updatedAt: nowIso });
    });
    await this.audit.record({
      type: 'employee.updated',
      actor,
      summary: `Employee ${cur.id} updated`,
      details: { employeeId: cur.id, fields: Object.keys(parsed.data) },
    });
    this.emit({ type: 'employee.changed', data: { employeeId: cur.id } });
    return this.require(cur.id);
  }

  async setActive(id: string, active: boolean, reason: string, actor: string): Promise<Employee> {
    const cur = this.require(id);
    if (active && cur.archivedAt) throw new PulseError('ARCHIVED', 'This employee is archived. Restore the employee before reactivating.', 409);
    if (!active && reason.trim().length < 3) throw new PulseError('VALIDATION', 'A reason is required to deactivate an employee');
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update((d) => {
      const e = d.employees.find((x) => x.id === cur.id)!;
      e.status = active ? 'active' : 'inactive';
      e.updatedAt = nowIso;
      if (active) {
        delete e.deactivatedAt;
        delete e.deactivatedReason;
      } else {
        e.deactivatedAt = nowIso;
        e.deactivatedReason = reason.trim();
      }
    });
    await this.audit.record({
      type: active ? 'employee.reactivated' : 'employee.deactivated',
      severity: active ? 'info' : 'notice',
      actor,
      summary: `Employee ${cur.id} ${active ? 'reactivated' : 'deactivated'}${active ? '' : ` — ${reason.trim()}`}`,
      details: { employeeId: cur.id },
    });
    this.emit({ type: 'employee.changed', data: { employeeId: cur.id } });
    return this.require(cur.id);
  }

  async archive(id: string, reason: string, actor: string): Promise<Employee> {
    const cur = this.require(id);
    if (cur.archivedAt) throw new PulseError('ARCHIVED', 'This employee is already archived', 409);
    if (cur.status === 'active') throw new PulseError('EMPLOYEE_ACTIVE', 'Deactivate the employee before archiving the record', 409);
    if (reason.trim().length < 3) throw new PulseError('VALIDATION', 'A reason is required to archive an employee');
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update((d) => {
      const e = d.employees.find((x) => x.id === cur.id)!;
      e.archivedAt = nowIso;
      e.archivedBy = actor;
      e.archivedReason = reason.trim().slice(0, 200);
      e.updatedAt = nowIso;
    });
    await this.audit.record({ type: 'employee.archived', severity: 'notice', actor, summary: `Employee ${cur.id} (${cur.fullName}) archived — ${reason.trim()}`, details: { employeeId: cur.id } });
    this.emit({ type: 'employee.changed', data: { employeeId: cur.id } });
    this.emit({ type: 'archive.changed', data: { entity: 'employee', id: cur.id, archived: true } });
    return this.require(cur.id);
  }

  async restore(id: string, actor: string): Promise<Employee> {
    const cur = this.require(id);
    if (!cur.archivedAt) throw new PulseError('NOT_ARCHIVED', 'This employee is not archived', 409);
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update((d) => {
      const e = d.employees.find((x) => x.id === cur.id)!;
      delete e.archivedAt;
      delete e.archivedBy;
      delete e.archivedReason;
      e.updatedAt = nowIso;
    });
    await this.audit.record({ type: 'employee.restored', severity: 'notice', actor, summary: `Employee ${cur.id} (${cur.fullName}) restored from the archive (inactive)`, details: { employeeId: cur.id } });
    this.emit({ type: 'employee.changed', data: { employeeId: cur.id } });
    this.emit({ type: 'archive.changed', data: { entity: 'employee', id: cur.id, archived: false } });
    return this.require(cur.id);
  }

  /** CSV columns: employeeId, fullName, phone, department (optional header row). */
  async importCsv(text: string, actor: string): Promise<{ created: number; skipped: Array<{ line: number; reason: string }> }> {
    if (text.length > 500_000) throw new PulseError('VALIDATION', 'CSV is too large');
    const rows = parseCsv(text);
    const skipped: Array<{ line: number; reason: string }> = [];
    let created = 0;
    let start = 0;
    if (rows[0] && /employee|^id$/i.test(rows[0][0] ?? '') && /name/i.test(rows[0][1] ?? '')) start = 1;
    for (let i = start; i < rows.length; i++) {
      const [id, name, phone, dept] = rows[i].map((x) => x.trim());
      try {
        await this.create({ id, fullName: name, phone, department: dept ?? '' }, actor);
        created++;
      } catch (e) {
        skipped.push({ line: i + 1, reason: e instanceof PulseError ? e.message : (e as Error).message });
      }
    }
    return { created, skipped };
  }
}
