// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { components } from '../../../api/schema';

export type DesktopApp = components['schemas']['DesktopApp'];

export const CUSTOM_SHORTCUTS_STORAGE_KEY = 'shellorchestra.customShortcuts.v1';
export const CUSTOM_SHORTCUTS_CHANGED_EVENT = 'shellorchestra-custom-shortcuts-changed';
export const CUSTOM_SHORTCUT_APP_ID_PREFIX = 'custom_shortcut_';
export const CUSTOM_SHORTCUT_TERMINAL_APP_ID = 'custom_terminal';
export const CUSTOM_SHORTCUT_COMMAND_MAX_BYTES = 4096;
export const CUSTOM_SHORTCUT_NAME_MAX_CHARS = 64;

export type CustomShortcut = {
  id: string;
  name: string;
  command: string;
  created_at: string;
  updated_at: string;
};

export type CustomShortcutDraft = Pick<CustomShortcut, 'id' | 'name' | 'command'>;

export type CustomShortcutValidation = {
  valid: boolean;
  errors: Record<'name' | 'command', string>;
};

export function loadCustomShortcuts(): CustomShortcut[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SHORTCUTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeCustomShortcut)
      .filter((shortcut): shortcut is CustomShortcut => Boolean(shortcut))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export function saveCustomShortcuts(shortcuts: CustomShortcut[]) {
  const normalized = shortcuts
    .map(normalizeCustomShortcut)
    .filter((shortcut): shortcut is CustomShortcut => Boolean(shortcut))
    .sort((left, right) => left.name.localeCompare(right.name));
  window.localStorage.setItem(CUSTOM_SHORTCUTS_STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(CUSTOM_SHORTCUTS_CHANGED_EVENT));
}

export function newCustomShortcutDraft(existing: CustomShortcut[] = []): CustomShortcutDraft {
  return {
    id: crypto.randomUUID(),
    name: uniqueShortcutName(existing, 'Custom command'),
    command: '',
  };
}

export function duplicateCustomShortcutDraft(shortcut: CustomShortcut, existing: CustomShortcut[] = []): CustomShortcutDraft {
  return {
    id: crypto.randomUUID(),
    name: uniqueShortcutName(existing, `${shortcut.name} copy`),
    command: shortcut.command,
  };
}

export function validateCustomShortcutDraft(draft: CustomShortcutDraft, existing: CustomShortcut[] = []): CustomShortcutValidation {
  const name = cleanShortcutName(draft.name);
  const command = cleanShortcutCommand(draft.command);
  const errors: CustomShortcutValidation['errors'] = { name: '', command: '' };
  if (!name) {
    errors.name = 'Enter a visible shortcut name.';
  } else if (name.length > CUSTOM_SHORTCUT_NAME_MAX_CHARS) {
    errors.name = `Shortcut names are limited to ${CUSTOM_SHORTCUT_NAME_MAX_CHARS} characters.`;
  } else if (hasUnsafeControl(name)) {
    errors.name = 'Shortcut names cannot contain control characters.';
  } else if (existing.some((item) => item.id !== draft.id && item.name.trim().toLowerCase() === name.toLowerCase())) {
    errors.name = 'Use a unique name so the launcher stays unambiguous.';
  }
  if (!command) {
    errors.command = 'Enter the command to run on the selected server.';
  } else if (utf8Bytes(command) > CUSTOM_SHORTCUT_COMMAND_MAX_BYTES) {
    errors.command = `Commands are limited to ${CUSTOM_SHORTCUT_COMMAND_MAX_BYTES} bytes.`;
  } else if (command.includes('\x00')) {
    errors.command = 'Commands cannot contain NUL bytes.';
  } else if (command.includes('\n') || command.includes('\r')) {
    errors.command = 'Use one command line here. Put multi-step logic into a script on the server and launch that script.';
  } else if (hasUnsafeControl(command)) {
    errors.command = 'Commands cannot contain unsupported control characters.';
  }
  return { valid: !errors.name && !errors.command, errors };
}

export function upsertCustomShortcut(draft: CustomShortcutDraft, existing: CustomShortcut[]): CustomShortcut[] {
  const now = new Date().toISOString();
  const current = existing.find((item) => item.id === draft.id);
  const next: CustomShortcut = {
    id: draft.id || crypto.randomUUID(),
    name: cleanShortcutName(draft.name).slice(0, CUSTOM_SHORTCUT_NAME_MAX_CHARS),
    command: cleanShortcutCommand(draft.command),
    created_at: current?.created_at || now,
    updated_at: now,
  };
  const items = existing.filter((item) => item.id !== next.id);
  return [...items, next].sort((left, right) => left.name.localeCompare(right.name));
}

export function removeCustomShortcut(id: string, existing: CustomShortcut[]): CustomShortcut[] {
  const normalizedID = id.trim();
  return existing.filter((item) => item.id !== normalizedID);
}

export function customShortcutAppID(shortcut: CustomShortcut): string {
  return `${CUSTOM_SHORTCUT_APP_ID_PREFIX}${shortcut.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`;
}

export function appIDToCustomShortcutID(appID: string): string {
  if (!appID.startsWith(CUSTOM_SHORTCUT_APP_ID_PREFIX)) return '';
  return appID.slice(CUSTOM_SHORTCUT_APP_ID_PREFIX.length);
}

export function customShortcutToDesktopApp(shortcut: CustomShortcut): DesktopApp {
  return {
    id: customShortcutAppID(shortcut),
    plugin_id: 'builtin',
    edition: 'community',
    title: shortcut.name,
    description: `Run in a terminal: ${shortcut.command}`,
    kind: 'terminal',
    icon: 'terminal',
    frontend_module: 'terminal_profile',
    backend_driver: 'terminal',
    detected_app: null,
    launch_command: CUSTOM_SHORTCUT_TERMINAL_APP_ID,
    install_command: null,
    data_command: null,
    actions: {},
    supported_os: ['linux', 'darwin', 'freebsd', 'windows'],
    requires_docker: false,
    hidden: false,
    capabilities: ['terminal-profile', 'custom-shortcuts'],
    permissions: ['ssh-session'],
    sandbox_policy: 'iframe-terminal',
    integrated_window: false,
    default_width: 900,
    default_height: 560,
    default_maximized: true,
    data_refresh_interval_seconds: 0,
    data_monitor_interval_seconds: 0,
    data_monitor_ttl_seconds: 0,
    supported: true,
    installed: true,
    installable: false,
    unavailable_hint: null,
  };
}

export function cleanShortcutName(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function cleanShortcutCommand(value: string): string {
  return value.trim();
}

export function customShortcutSummary(shortcut: CustomShortcut): string {
  return shortcut.command.length > 96 ? `${shortcut.command.slice(0, 93)}…` : shortcut.command;
}

function normalizeCustomShortcut(value: unknown): CustomShortcut | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<CustomShortcut>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? cleanShortcutName(raw.name) : '';
  const command = typeof raw.command === 'string' ? cleanShortcutCommand(raw.command) : '';
  if (!id || !name || !command) return null;
  if (id.length > 128 || name.length > CUSTOM_SHORTCUT_NAME_MAX_CHARS || utf8Bytes(command) > CUSTOM_SHORTCUT_COMMAND_MAX_BYTES) return null;
  if (hasUnsafeControl(name) || hasUnsafeControl(command) || command.includes('\x00') || command.includes('\n') || command.includes('\r')) return null;
  const now = new Date().toISOString();
  return {
    id,
    name,
    command,
    created_at: typeof raw.created_at === 'string' && raw.created_at ? raw.created_at : now,
    updated_at: typeof raw.updated_at === 'string' && raw.updated_at ? raw.updated_at : now,
  };
}

function uniqueShortcutName(existing: CustomShortcut[], baseName: string): string {
  const taken = new Set(existing.map((item) => item.name.trim().toLowerCase()));
  let candidate = cleanShortcutName(baseName) || 'Custom command';
  if (!taken.has(candidate.toLowerCase())) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    candidate = `${baseName} ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${baseName} ${Date.now()}`.slice(0, CUSTOM_SHORTCUT_NAME_MAX_CHARS);
}

function hasUnsafeControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9) return true;
    if (code === 127) return true;
  }
  return false;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
