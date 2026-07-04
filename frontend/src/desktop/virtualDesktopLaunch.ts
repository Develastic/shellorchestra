// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type VirtualDesktopOpenMode = 'new-tab' | 'same-window';

export type OpenVirtualDesktopEntry = {
  serverID: string;
  label: string;
  openedAt: string;
};

type VirtualDesktopServerLike = {
  id: string;
  name?: string | null;
};

const openModeStorageKey = 'shellorchestra.virtualDesktop.openMode.v1';
const openDesktopsStorageKey = 'shellorchestra.virtualDesktop.openDesktops.v1';
const openDesktopsRuntimeStorageKey = 'shellorchestra.virtualDesktop.openDesktops.runtime.v1';
const preferencesEventName = 'shellorchestra:virtual-desktop-client-preferences';
const openDesktopsEventName = 'shellorchestra:virtual-desktop-open-desktops';

export function readVirtualDesktopOpenMode(): VirtualDesktopOpenMode {
  if (typeof window === 'undefined') return 'new-tab';
  try {
    const value = window.localStorage.getItem(openModeStorageKey);
    if (value === 'new-tab' || value === 'same-window') return value;
  } catch {
    // Storage can be unavailable in hardened/private browsers. Use a safe runtime default.
  }
  return defaultVirtualDesktopOpenMode();
}

export function writeVirtualDesktopOpenMode(mode: VirtualDesktopOpenMode) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(openModeStorageKey, mode);
  } catch {
    // Keep the current in-memory UI usable even if local storage is blocked.
  }
  window.dispatchEvent(new CustomEvent(preferencesEventName, { detail: { mode } }));
}

export function subscribeVirtualDesktopOpenMode(listener: (mode: VirtualDesktopOpenMode) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const notify = () => listener(readVirtualDesktopOpenMode());
  const onStorage = (event: StorageEvent) => {
    if (event.key === openModeStorageKey) notify();
  };
  window.addEventListener(preferencesEventName, notify);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(preferencesEventName, notify);
    window.removeEventListener('storage', onStorage);
  };
}

export function readOpenVirtualDesktops(): OpenVirtualDesktopEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(openDesktopsStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeOpenDesktopEntry)
      .filter((entry): entry is OpenVirtualDesktopEntry => entry !== null)
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  } catch {
    return [];
  }
}

export function reconcileOpenVirtualDesktopsRuntime(runtimeSessionID: string): OpenVirtualDesktopEntry[] {
  if (typeof window === 'undefined') return [];
  const marker = runtimeSessionID.trim();
  if (!marker) return readOpenVirtualDesktops();
  let changed = false;
  try {
    const previous = window.localStorage.getItem(openDesktopsRuntimeStorageKey);
    if (previous !== marker) {
      window.localStorage.setItem(openDesktopsRuntimeStorageKey, marker);
      window.localStorage.removeItem(openDesktopsStorageKey);
      changed = true;
    }
  } catch {
    return readOpenVirtualDesktops();
  }
  const entries = changed ? [] : readOpenVirtualDesktops();
  if (changed) {
    window.dispatchEvent(new CustomEvent(openDesktopsEventName, { detail: { entries } }));
  }
  return entries;
}

export function subscribeOpenVirtualDesktops(listener: (entries: OpenVirtualDesktopEntry[]) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const notify = () => listener(readOpenVirtualDesktops());
  const onStorage = (event: StorageEvent) => {
    if (event.key === openDesktopsStorageKey) notify();
  };
  window.addEventListener(openDesktopsEventName, notify);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(openDesktopsEventName, notify);
    window.removeEventListener('storage', onStorage);
  };
}

export function removeOpenVirtualDesktop(serverID: string): OpenVirtualDesktopEntry[] {
  if (typeof window === 'undefined') return [];
  const normalizedID = serverID.trim();
  if (!normalizedID) return readOpenVirtualDesktops();
  const next = readOpenVirtualDesktops().filter((entry) => entry.serverID !== normalizedID);
  try {
    window.localStorage.setItem(openDesktopsStorageKey, JSON.stringify(next));
  } catch {
    // Keep the in-memory notification path alive even if persistent storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(openDesktopsEventName, { detail: { entries: next } }));
  return next;
}

export function recordOpenVirtualDesktop(server: VirtualDesktopServerLike) {
  if (typeof window === 'undefined' || !server.id) return;
  const label = desktopLabel(server);
  const nextEntry: OpenVirtualDesktopEntry = {
    serverID: server.id,
    label,
    openedAt: new Date().toISOString(),
  };
  const next = [nextEntry, ...readOpenVirtualDesktops().filter((entry) => entry.serverID !== server.id)].slice(0, 32);
  try {
    window.localStorage.setItem(openDesktopsStorageKey, JSON.stringify(next));
  } catch {
    // The navigation itself is more important than persisting the sidebar shortcut.
  }
  window.dispatchEvent(new CustomEvent(openDesktopsEventName, { detail: { entries: next } }));
}

export function openVirtualDesktopForServer(server: VirtualDesktopServerLike, mode = readVirtualDesktopOpenMode()) {
  if (typeof window === 'undefined' || !server.id) return;
  preloadVirtualDesktopPage();
  recordOpenVirtualDesktop(server);
  const encodedID = encodeURIComponent(server.id);
  const desktopPath = `/desktop/${encodedID}`;
  if (mode === 'same-window') {
    const sameWindowPath = `/virtual-desktops/${encodedID}`;
    if (window.location.pathname !== sameWindowPath) {
      window.location.assign(sameWindowPath);
    }
    return;
  }
  focusOrOpenVirtualDesktopWindow(desktopPath, virtualDesktopWindowName(server.id));
}

function focusOrOpenVirtualDesktopWindow(path: string, name: string) {
  const absoluteURL = new URL(path, window.location.origin).href;
  const handle = window.open('', name);
  if (!handle) return;
  try {
    const currentURL = handle.location.href;
    if (currentURL === 'about:blank' || currentURL !== absoluteURL) {
      handle.location.replace(absoluteURL);
    }
  } catch {
    // If the named window is not inspectable, focus it rather than forcing a reload.
  }
  handle.focus();
}

export function preloadVirtualDesktopPage() {
  void import('../pages/VirtualDesktopPage');
}

export function virtualDesktopFrameURL(serverID: string): string {
  return `/desktop/${encodeURIComponent(serverID)}`;
}

export function virtualDesktopSameWindowURL(serverID: string): string {
  return `/virtual-desktops/${encodeURIComponent(serverID)}`;
}

function defaultVirtualDesktopOpenMode(): VirtualDesktopOpenMode {
  if (isStandaloneShellOrchestraClient()) return 'same-window';
  return 'new-tab';
}

function isStandaloneShellOrchestraClient(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean; userAgentData?: { brands?: Array<{ brand: string }> } };
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  if (window.matchMedia?.('(display-mode: window-controls-overlay)').matches) return true;
  if (nav.standalone === true) return true;
  const userAgent = nav.userAgent || '';
  if (/ShellOrchestraDesktop/i.test(userAgent)) return true;
  if (nav.userAgentData?.brands?.some((brand) => /ShellOrchestraDesktop/i.test(brand.brand))) return true;
  return false;
}

function virtualDesktopWindowName(serverID: string): string {
  return `shellorchestra-desktop-${serverID.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function desktopLabel(server: VirtualDesktopServerLike): string {
  const label = typeof server.name === 'string' ? server.name.trim() : '';
  return label || server.id;
}

function normalizeOpenDesktopEntry(value: unknown): OpenVirtualDesktopEntry | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<OpenVirtualDesktopEntry>;
  if (typeof payload.serverID !== 'string' || payload.serverID.trim() === '') return null;
  return {
    serverID: payload.serverID,
    label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : payload.serverID,
    openedAt: typeof payload.openedAt === 'string' && payload.openedAt.trim() ? payload.openedAt : new Date(0).toISOString(),
  };
}
