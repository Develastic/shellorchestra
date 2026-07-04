// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { formatBytesCompact } from '../shared';

export type PackageManagerAction = 'installed' | 'search' | 'upgradable' | 'security' | 'info';

export type PackageDTO = {
  name?: string;
  version?: string;
  description?: string;
  installed?: boolean;
  upgradable?: boolean;
  security?: boolean;
  severity?: string;
  advisory?: string;
  cves?: string[];
  fixed_version?: string;
};

export type PackageManagerDTO = {
  generated_at?: string;
  manager?: string;
  action?: string;
  query?: string;
  state_token?: string;
  not_modified?: boolean;
  packages?: PackageDTO[];
  info?: string;
  metadata_updated_at?: string;
  metadata_age_seconds?: number | null;
  metadata_status?: string;
  metadata_refresh_hint?: string;
};

export class PackageEntry {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly installed: boolean;
  readonly upgradable: boolean;
  readonly security: boolean;
  readonly severity: string;
  readonly advisory: string;
  readonly cves: string[];
  readonly fixedVersion: string;

  constructor(dto: PackageDTO) {
    this.name = typeof dto.name === 'string' ? dto.name.trim() : '';
    this.version = typeof dto.version === 'string' ? dto.version.trim() : '';
    this.description = typeof dto.description === 'string' ? dto.description.trim() : '';
    this.installed = dto.installed === true;
    this.upgradable = dto.upgradable === true;
    this.security = dto.security === true;
    this.severity = typeof dto.severity === 'string' ? dto.severity.trim() : '';
    this.advisory = typeof dto.advisory === 'string' ? dto.advisory.trim() : '';
    this.cves = Array.isArray(dto.cves) ? dto.cves.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean) : [];
    this.fixedVersion = typeof dto.fixed_version === 'string' ? dto.fixed_version.trim() : '';
  }

  get label(): string {
    return this.version ? `${this.name} ${this.version}` : this.name;
  }
}

export class PackageCollection {
  readonly items: PackageEntry[];

  constructor(items: PackageEntry[]) {
    this.items = items;
  }

  static fromDTO(values: unknown): PackageCollection {
    if (!Array.isArray(values)) return new PackageCollection([]);
    return new PackageCollection(values.map((value) => new PackageEntry(value as PackageDTO)).filter((entry) => entry.name));
  }

  filter(query: string): PackageCollection {
    const needle = query.trim().toLowerCase();
    if (!needle) return this;
    return new PackageCollection(this.items.filter((item) => `${item.name} ${item.version} ${item.description} ${item.severity} ${item.advisory} ${item.cves.join(' ')}`.toLowerCase().includes(needle)));
  }
}

export class PackageManagerPayload {
  readonly generatedAt: string;
  readonly manager: string;
  readonly action: PackageManagerAction;
  readonly query: string;
  readonly stateToken: string;
  readonly notModified: boolean;
  readonly packages: PackageCollection;
  readonly info: string;
  readonly metadataUpdatedAt: string;
  readonly metadataAgeSeconds: number | null;
  readonly metadataStatus: string;
  readonly metadataRefreshHint: string;

  constructor(dto: PackageManagerDTO) {
    this.generatedAt = typeof dto.generated_at === 'string' ? dto.generated_at : '';
    this.manager = typeof dto.manager === 'string' && dto.manager.trim() ? dto.manager.trim() : 'unknown';
    this.action = normalizePackageAction(dto.action);
    this.query = typeof dto.query === 'string' ? dto.query : '';
    this.stateToken = typeof dto.state_token === 'string' ? dto.state_token.trim() : '';
    this.notModified = dto.not_modified === true;
    this.packages = PackageCollection.fromDTO(dto.packages);
    this.info = typeof dto.info === 'string' ? dto.info : '';
    this.metadataUpdatedAt = typeof dto.metadata_updated_at === 'string' ? dto.metadata_updated_at : '';
    this.metadataAgeSeconds = typeof dto.metadata_age_seconds === 'number' && Number.isFinite(dto.metadata_age_seconds) ? dto.metadata_age_seconds : null;
    this.metadataStatus = typeof dto.metadata_status === 'string' ? dto.metadata_status.trim() : '';
    this.metadataRefreshHint = typeof dto.metadata_refresh_hint === 'string' ? dto.metadata_refresh_hint.trim() : '';
  }

  static fromUnknown(value: unknown): PackageManagerPayload {
    if (!value || typeof value !== 'object') return new PackageManagerPayload({});
    return new PackageManagerPayload(value as PackageManagerDTO);
  }

  updatedLabel(): string {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleTimeString();
  }

  metadataUpdatedLabel(): string {
    if (!this.metadataUpdatedAt) return this.metadataStatus === 'unsupported' ? 'unsupported' : 'unknown';
    const date = new Date(this.metadataUpdatedAt);
    if (Number.isNaN(date.getTime())) return this.metadataUpdatedAt;
    return date.toLocaleString();
  }

  metadataAgeLabel(): string {
    if (typeof this.metadataAgeSeconds !== 'number') return this.metadataStatus === 'unsupported' ? 'not used' : 'unknown age';
    const hours = this.metadataAgeSeconds / 3600;
    if (hours < 1) return `${Math.max(1, Math.round(this.metadataAgeSeconds / 60))} min old`;
    if (hours < 48) return `${Math.round(hours)} h old`;
    return `${Math.round(hours / 24)} d old`;
  }

  metadataIsStale(maxAgeSeconds = 86400): boolean {
    if (this.metadataStatus === 'stale' || this.metadataStatus === 'unknown') return true;
    return typeof this.metadataAgeSeconds === 'number' && this.metadataAgeSeconds > maxAgeSeconds;
  }

  withRefreshMetadata(dto: Pick<PackageManagerPayload, 'generatedAt' | 'stateToken' | 'notModified' | 'metadataUpdatedAt' | 'metadataAgeSeconds' | 'metadataStatus' | 'metadataRefreshHint'>): PackageManagerPayload {
    return new PackageManagerPayload({
      generated_at: dto.generatedAt || this.generatedAt,
      manager: this.manager,
      action: this.action,
      query: this.query,
      state_token: dto.stateToken || this.stateToken,
      not_modified: false,
      packages: this.packages.items.map((item) => ({
        name: item.name,
        version: item.version,
        description: item.description,
        installed: item.installed,
        upgradable: item.upgradable,
        security: item.security,
        severity: item.severity,
        advisory: item.advisory,
        cves: item.cves,
        fixed_version: item.fixedVersion,
      })),
      info: this.info,
      metadata_updated_at: dto.metadataUpdatedAt || this.metadataUpdatedAt,
      metadata_age_seconds: dto.metadataAgeSeconds ?? this.metadataAgeSeconds,
      metadata_status: dto.metadataStatus || this.metadataStatus,
      metadata_refresh_hint: dto.metadataRefreshHint || this.metadataRefreshHint,
    });
  }
}

export class PackageMutationDraft {
  readonly packageName: string;
  readonly manager: string;

  constructor(packageName: string, manager: string) {
    this.packageName = packageName.trim();
    this.manager = manager.trim() || 'auto';
  }

  validate(): string | null {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/.test(this.packageName)) {
      return 'Enter the exact package name. Allowed characters: letters, digits, dot, underscore, plus, colon, and hyphen.';
    }
    return null;
  }

  toArgs(): Record<string, string> {
    return { package_name: this.packageName, package_manager: this.manager };
  }
}

export function normalizePackageAction(value: unknown): PackageManagerAction {
  return value === 'search' || value === 'upgradable' || value === 'security' || value === 'info' ? value : 'installed';
}

export function packageCountLabel(count: number): string {
  return `${count} package${count === 1 ? '' : 's'}`;
}

export function installedFootprintLabel(bytes?: number): string {
  return formatBytesCompact(bytes);
}
