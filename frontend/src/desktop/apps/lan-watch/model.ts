// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { numberOrUndefined } from '../shared';

export type LanSubnetDTO = { interface?: string; address?: string; prefix?: string | number; network?: string };
export type LanHostDTO = { ip?: string; mac?: string; interface?: string; ssh_open?: boolean; ssh_banner?: string };
export type LanWatchDTO = { generated_at?: string; platform?: string; source?: string; limit?: number; no_probe?: boolean; candidate_count?: number; checked?: number; remaining?: number; probe_backend?: string; probe_backend_available?: boolean; probe_backend_missing?: boolean; probe_backend_message?: string; subnets?: LanSubnetDTO[]; hosts?: LanHostDTO[] };

export class LanSubnet {
  readonly iface: string;
  readonly address: string;
  readonly prefix: string;
  readonly network: string;
  constructor(dto: LanSubnetDTO) { this.iface = text(dto.interface); this.address = text(dto.address); this.prefix = text(dto.prefix); this.network = text(dto.network); }
  label(): string { return this.network || `${this.address}/${this.prefix}`; }
}

export class LanHost {
  readonly id: string;
  readonly ip: string;
  readonly mac: string;
  readonly iface: string;
  readonly sshOpen: boolean;
  readonly sshBanner: string;
  readonly detectedOS: string;
  readonly detectedOSLabel: string;
  constructor(dto: LanHostDTO, index: number) {
    this.ip = text(dto.ip);
    this.mac = text(dto.mac);
    this.iface = text(dto.interface);
    this.sshOpen = dto.ssh_open === true;
    this.sshBanner = text(dto.ssh_banner);
    this.detectedOS = inferOSFromSSHBanner(this.sshBanner);
    this.detectedOSLabel = detectedOSLabel(this.detectedOS);
    this.id = `${this.ip || index}-${this.mac}`;
  }
  matches(query: string): boolean { const needle = query.trim().toLowerCase(); if (!needle) return true; return [this.ip, this.mac, this.iface, this.detectedOSLabel, this.sshBanner, this.sshOpen ? 'ssh open' : ''].join(' ').toLowerCase().includes(needle); }
}

export class LanHostCollection {
  readonly items: LanHost[];
  constructor(items: LanHost[]) { this.items = items; }
  static fromUnknown(value: unknown): LanHostCollection { if (!Array.isArray(value)) return new LanHostCollection([]); return new LanHostCollection(value.map((item, index) => new LanHost(item as LanHostDTO, index)).filter((item) => item.ip)); }
  filter(query: string): LanHostCollection { return new LanHostCollection(this.items.filter((item) => item.matches(query))); }
  sshOpenCount(): number { return this.items.filter((item) => item.sshOpen).length; }
}

export class LanWatchPayload {
  readonly generatedAt: string;
  readonly platform: string;
  readonly source: string;
  readonly limit: number;
  readonly noProbe: boolean;
  readonly candidateCount: number;
  readonly checked: number;
  readonly remaining: number;
  readonly probeBackend: string;
  readonly probeBackendAvailable: boolean;
  readonly probeBackendMissing: boolean;
  readonly probeBackendMessage: string;
  readonly subnets: LanSubnet[];
  readonly hosts: LanHostCollection;
  constructor(dto: LanWatchDTO) {
    this.generatedAt = text(dto.generated_at);
    this.platform = text(dto.platform);
    this.source = text(dto.source);
    this.limit = numberOrUndefined(dto.limit) ?? 0;
    this.noProbe = dto.no_probe === true;
    this.candidateCount = clampNonNegative(numberOrUndefined(dto.candidate_count));
    this.checked = clampNonNegative(numberOrUndefined(dto.checked));
    this.remaining = clampNonNegative(numberOrUndefined(dto.remaining));
    this.probeBackend = text(dto.probe_backend);
    this.probeBackendMissing = dto.probe_backend_missing === true;
    this.probeBackendAvailable = dto.probe_backend_available === true && !this.probeBackendMissing;
    this.probeBackendMessage = text(dto.probe_backend_message);
    this.subnets = Array.isArray(dto.subnets) ? dto.subnets.map((item) => new LanSubnet(item)) : [];
    this.hosts = LanHostCollection.fromUnknown(dto.hosts);
  }
  static fromUnknown(value: unknown): LanWatchPayload { if (!value || typeof value !== 'object') return new LanWatchPayload({}); return new LanWatchPayload(value as LanWatchDTO); }
  updatedLabel(): string { if (!this.generatedAt) return '—'; const date = new Date(this.generatedAt); if (Number.isNaN(date.getTime())) return this.generatedAt; return date.toLocaleTimeString(); }
  subnetLabel(): string { if (this.subnets.length === 0) return 'No local IPv4 subnet detected'; return this.subnets.map((item) => `${item.label()} (${item.iface})`).join(', '); }
  probeBackendLabel(): string { return this.probeBackend || 'unknown'; }
  progressLabel(): string { return this.checked || this.remaining || this.candidateCount ? `${this.checked} checked · ${this.remaining} remaining` : '—'; }
}

function text(value: unknown): string { if (typeof value === 'string') return value.trim(); const number = numberOrUndefined(value); return number === undefined ? '' : String(number); }
function clampNonNegative(value: number | undefined): number { return Math.max(0, Math.floor(value ?? 0)); }

function inferOSFromSSHBanner(banner: string): string {
  const textValue = banner.toLowerCase();
  if (!textValue) return '';
  if (textValue.includes('openssh_for_windows') || /\bwindows\b/.test(textValue)) return 'windows';
  if (/\bubuntu\b/.test(textValue)) return 'ubuntu';
  if (/\bdebian\b|\bdeb\d+\b/.test(textValue)) return 'debian';
  if (/\balpine\b/.test(textValue)) return 'alpine';
  if (/\barch\b/.test(textValue)) return 'arch';
  if (/\bfedora\b/.test(textValue)) return 'fedora';
  if (/\brocky\b/.test(textValue)) return 'rocky';
  if (/\balma\b/.test(textValue)) return 'almalinux';
  if (/\bcentos\b/.test(textValue)) return 'centos';
  if (/\bred\s*hat\b|\brhel\b/.test(textValue)) return 'redhat';
  if (/\bproxmox\b|\bpve\b/.test(textValue)) return 'proxmox';
  if (/\bsuse\b|\bopensuse\b|\bsles\b/.test(textValue)) return 'opensuse';
  if (/\braspbian\b|\braspberry\b/.test(textValue)) return 'raspberry pi os';
  if (/\bdarwin\b|\bmacos\b/.test(textValue)) return 'macos';
  if (textValue.includes('openssh')) return 'linux';
  return '';
}

function detectedOSLabel(value: string): string {
  if (!value) return '';
  const normalized = value.toLowerCase();
  if (normalized === 'almalinux') return 'AlmaLinux';
  if (normalized === 'raspberry pi os') return 'Raspberry Pi OS';
  if (normalized === 'macos') return 'macOS';
  return normalized.split(/\s+/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ');
}
