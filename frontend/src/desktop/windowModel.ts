// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { components } from '../api/schema';
import { desktopAppPlugins, normalizeDesktopWindowKind, type DesktopWindowKind } from './apps/pluginDefinitions';
export type { DesktopWindowKind } from './apps/pluginDefinitions';

export type DesktopWindowSnapshot = components['schemas']['VirtualDesktopWindow'] & {
  app_id?: string;
  plugin_id?: string;
  frontend_module?: string;
  kind: DesktopWindowKind;
};

export class DesktopWindowModel {
  readonly value: DesktopWindowSnapshot;

  constructor(value: DesktopWindowSnapshot, index = 0) {
    this.value = DesktopWindowModel.normalize(value, index);
  }

  static create(kind: DesktopWindowKind, index: number, patch: Partial<DesktopWindowSnapshot> = {}): DesktopWindowSnapshot {
    const defaults = desktopAppPlugins.windowDefaultsFor(kind, patch.app_id, patch.frontend_module);
    return DesktopWindowModel.normalize({
      id: `${kind}-${crypto.randomUUID()}`,
      app_id: kind,
      plugin_id: 'builtin',
      frontend_module: kind,
      title: DesktopWindowModel.titleForKind(kind),
      kind,
      x: 72 + index * 24,
      y: 72 + index * 18,
      width: defaults.width,
      height: defaults.height,
      minimized: false,
      maximized: defaults.maximized,
      z_index: index + 1,
      ...patch,
    } as DesktopWindowSnapshot, index);
  }

  static normalize(value: DesktopWindowSnapshot, index = 0): DesktopWindowSnapshot {
    const kind = normalizeDesktopWindowKind(value.kind) ?? 'terminal';
    const defaults = desktopAppPlugins.windowDefaultsFor(kind, value.app_id, value.frontend_module);
    const minWidth = Math.max(240, Math.round(defaults.minWidth ?? 240));
    const minHeight = Math.max(160, Math.round(defaults.minHeight ?? 160));
    return {
      ...value,
      id: sanitizeToken(value.id) || `${kind}-${crypto.randomUUID()}`,
      app_id: sanitizeToken(value.app_id ?? '') || kind,
      plugin_id: sanitizeToken(value.plugin_id ?? '') || 'builtin',
      frontend_module: sanitizeToken(value.frontend_module ?? '') || kind,
      kind,
      title: sanitizeLabel(value.title) || DesktopWindowModel.titleForKind(kind),
      x: roundedPixel(value.x, 72 + index * 24),
      y: roundedPixel(value.y, 72 + index * 18),
      width: Math.max(minWidth, roundedPixel(value.width, defaults.width)),
      height: Math.max(minHeight, roundedPixel(value.height, defaults.height)),
      minimized: Boolean(value.minimized),
      maximized: Boolean(value.maximized),
      z_index: roundedPixel(value.z_index, index + 1) || index + 1,
      terminal_session_id: sanitizeToken(value.terminal_session_id ?? '') || undefined,
      metadata: sanitizeMetadata(value.metadata),
    };
  }

  static supportedKind(value: unknown): value is DesktopWindowKind {
    return desktopAppPlugins.supportedWindowKind(value);
  }

  static titleForKind(kind: DesktopWindowKind): string {
    return desktopAppPlugins.titleForKind(kind);
  }
}

export class DesktopWindowCollection {
  readonly windows: DesktopWindowSnapshot[];

  constructor(windows: DesktopWindowSnapshot[] = []) {
    this.windows = windows.map((windowState, index) => DesktopWindowModel.normalize(windowState, index));
  }

  static fromAPI(values: components['schemas']['VirtualDesktopWindow'][] | null | undefined): DesktopWindowCollection {
    const supported = (values ?? [])
      .map(migrateLegacyDesktopWindow)
      .filter((windowState): windowState is DesktopWindowSnapshot => DesktopWindowModel.supportedKind(windowState.kind));
    return new DesktopWindowCollection(supported);
  }

  map(producer: (windows: DesktopWindowSnapshot[]) => DesktopWindowSnapshot[]): DesktopWindowCollection {
    return new DesktopWindowCollection(producer(this.windows));
  }

  bringToFront(id: string): DesktopWindowCollection {
    const maxZ = this.windows.reduce((max, item) => Math.max(max, item.z_index), 0);
    return this.map((windows) => windows.map((item) => item.id === id ? { ...item, z_index: maxZ + 1 } : item));
  }

  activeWindowID(): string {
    return [...this.windows]
      .filter((item) => !item.minimized)
      .sort((left, right) => right.z_index - left.z_index)[0]?.id ?? '';
  }

  fingerprint(): string {
    return this.windows.map((windowState) => `${windowState.id}:${windowState.app_id ?? ''}:${windowState.plugin_id ?? ''}:${windowState.frontend_module ?? ''}:${windowState.kind}:${windowState.x}:${windowState.y}:${windowState.width}:${windowState.height}:${windowState.minimized ? 1 : 0}:${windowState.maximized ? 1 : 0}:${windowState.z_index}:${windowState.terminal_session_id ?? ''}:${metadataFingerprint(windowState.metadata)}`).join('|');
  }

  equals(other: DesktopWindowCollection): boolean {
    return this.fingerprint() === other.fingerprint();
  }
}

export function desktopWindowEqual(left: DesktopWindowSnapshot, right: DesktopWindowSnapshot): boolean {
  return DesktopWindowModel.normalize(left).id === DesktopWindowModel.normalize(right).id
    && DesktopWindowCollection.fromAPI([left]).fingerprint() === DesktopWindowCollection.fromAPI([right]).fingerprint();
}

function roundedPixel(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(value);
}

function sanitizeToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
}

function sanitizeLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function sanitizeMetadata(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = sanitizeToken(rawKey).slice(0, 64);
    if (!key || typeof rawValue !== 'string') continue;
    const cleaned = rawValue.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1024);
    if (cleaned) out[key] = cleaned;
  }
  return Object.keys(out).length ? out : undefined;
}

function metadataFingerprint(value: Record<string, string> | undefined): string {
  if (!value) return '';
  return Object.keys(value).sort().map((key) => `${key}=${value[key]}`).join('&');
}

function migrateLegacyDesktopWindow(value: components['schemas']['VirtualDesktopWindow']): components['schemas']['VirtualDesktopWindow'] {
  const appID = typeof value.app_id === 'string' ? value.app_id.trim() : '';
  const title = typeof value.title === 'string' ? value.title.trim().toLowerCase() : '';
  const frontendModule = typeof value.frontend_module === 'string' ? value.frontend_module.trim() : '';
  if (appID !== 'docker_ps' && !(title === 'docker watch' && frontendModule === 'terminal_profile')) return value;
  return {
    ...value,
    app_id: 'containers',
    plugin_id: 'builtin',
    frontend_module: 'containers',
    kind: 'containers',
    title: 'Containers',
    terminal_session_id: undefined,
    metadata: { ...(value.metadata ?? {}), data_refresh_interval_seconds: '5' },
  };
}
