// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { formatBytesCompact, numberOrUndefined } from '../shared';

export type PVEResourceDTO = Record<string, unknown> & {
  id?: string;
  vmid?: string | number;
  name?: string;
  node?: string;
  type?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
};
export type PVEManagerPayloadDTO = {
  available?: boolean;
  is_pve?: boolean;
  message?: string;
  source?: string;
  node?: string;
  generated_at?: string;
  resources?: PVEResourceDTO[];
  node_status?: Record<string, unknown>;
};

export type PVEGuestAction = 'start' | 'shutdown' | 'reboot' | 'stop';

export class PVEGuest {
  readonly id: string;
  readonly vmid: string;
  readonly name: string;
  readonly node: string;
  readonly type: string;
  readonly status: string;
  readonly cpu: number | undefined;
  readonly maxCPU: number | undefined;
  readonly memory: number | undefined;
  readonly maxMemory: number | undefined;
  readonly disk: number | undefined;
  readonly maxDisk: number | undefined;
  readonly uptime: number | undefined;
  constructor(dto: PVEResourceDTO, index: number) {
    this.id = text(dto.id) || `guest-${index}`;
    this.vmid = dto.vmid === undefined || dto.vmid === null ? '' : String(dto.vmid).trim();
    this.name = text(dto.name) || this.vmid || this.id;
    this.node = text(dto.node);
    this.type = normalizeType(text(dto.type));
    this.status = text(dto.status) || 'unknown';
    this.cpu = numberOrUndefined(dto.cpu);
    this.maxCPU = numberOrUndefined(dto.maxcpu);
    this.memory = numberOrUndefined(dto.mem);
    this.maxMemory = numberOrUndefined(dto.maxmem);
    this.disk = numberOrUndefined(dto.disk);
    this.maxDisk = numberOrUndefined(dto.maxdisk);
    this.uptime = numberOrUndefined(dto.uptime);
  }
  typeLabel(): string { return this.type === 'lxc' ? 'Container' : this.type === 'qemu' ? 'VM' : this.type || 'Guest'; }
  statusTone(): 'success' | 'warning' | 'default' { return this.status === 'running' ? 'success' : this.status === 'stopped' ? 'default' : 'warning'; }
  memoryLabel(): string { return this.maxMemory ? `${formatBytesCompact(this.memory ?? 0)} / ${formatBytesCompact(this.maxMemory)}` : formatBytesCompact(this.memory); }
  diskLabel(): string { return this.maxDisk ? `${formatBytesCompact(this.disk ?? 0)} / ${formatBytesCompact(this.maxDisk)}` : formatBytesCompact(this.disk); }
  uptimeLabel(): string { return formatDuration(this.uptime); }
  canRunAction(action: PVEGuestAction): boolean {
    if (!this.vmid || !['qemu', 'lxc'].includes(this.type)) return false;
    if (action === 'start') return this.status !== 'running';
    return this.status === 'running';
  }
  actionArgs(action: PVEGuestAction): Record<string, string> { return { pve_action: action, pve_guest_type: this.type, pve_vmid: this.vmid }; }
}

export class PVEGuestCollection {
  readonly items: PVEGuest[];
  constructor(items: PVEGuest[]) { this.items = items.filter((item) => item.vmid); }
  static fromUnknown(value: unknown): PVEGuestCollection {
    if (!Array.isArray(value)) return new PVEGuestCollection([]);
    return new PVEGuestCollection(value.map((item, index) => new PVEGuest(item as PVEResourceDTO, index)));
  }
  filter(query: string): PVEGuestCollection {
    const needle = query.trim().toLowerCase();
    if (!needle) return this;
    return new PVEGuestCollection(this.items.filter((item) => [item.vmid, item.name, item.node, item.type, item.status].some((value) => value.toLowerCase().includes(needle))));
  }
}

export class PVEManagerPayload {
  readonly available: boolean;
  readonly isPVE: boolean;
  readonly message: string;
  readonly source: string;
  readonly node: string;
  readonly generatedAt: string;
  readonly guests: PVEGuestCollection;
  constructor(dto: PVEManagerPayloadDTO) {
    this.available = dto.available !== false;
    this.isPVE = Boolean(dto.is_pve);
    this.message = text(dto.message);
    this.source = text(dto.source);
    this.node = text(dto.node);
    this.generatedAt = text(dto.generated_at);
    this.guests = PVEGuestCollection.fromUnknown(dto.resources);
  }
  static fromUnknown(value: unknown): PVEManagerPayload {
    if (!value || typeof value !== 'object') return new PVEManagerPayload({ available: false, message: 'Virtual Machines did not receive a valid response from the server.' });
    return new PVEManagerPayload(value as PVEManagerPayloadDTO);
  }
}

export class PVEGuestActionDraft {
  readonly guest: PVEGuest;
  readonly action: PVEGuestAction;
  constructor(guest: PVEGuest, action: PVEGuestAction) { this.guest = guest; this.action = action; }
  validate(): string | null {
    if (!this.guest.canRunAction(this.action)) return `${this.action} is not available for ${this.guest.name}.`;
    return null;
  }
  toArgs(): Record<string, string> { return this.guest.actionArgs(this.action); }
}

function normalizeType(value: string): string {
  if (value === 'vm') return 'qemu';
  if (value === 'ct' || value === 'openvz') return 'lxc';
  return value;
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function formatDuration(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
