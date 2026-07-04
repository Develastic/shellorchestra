// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { api } from '../api/client';
import type { components } from '../api/schema';
import garageEmptyURL from '../assets/wallpapers/garage-empty.png';
import garageHotrodURL from '../assets/wallpapers/garage-hotrod.png';
import { signRequestInit } from '../security/requestSigning';

export type UISettings = components['schemas']['UISettings'];
export type UISettingsInput = components['schemas']['UISettingsInput'];
export type WallpaperChoice = UISettings['wallpaper_choice'];
export type WallpaperSurface = 'public' | 'app';

const csrfCookieName = 'shellorchestra_csrf';
const csrfHeaderName = 'X-ShellOrchestra-CSRF';

export const defaultUISettings: UISettings = {
  wallpaper_choice: 'garage_empty',
  wallpaper_dim_percent: 64,
  wallpaper_overridden: false,
  locale_override: null,
  timezone_override: null,
  terminal_font_size: 13,
  terminal_scrollback_lines: 5000,
  terminal_cursor_style: 'underline',
  terminal_keymap_layout: 'en',
  terminal_suppress_touch_keyboard: false,
  terminal_tmux_prefix_guard: true,
  desktop_control_height_px: 40,
  desktop_window_padding_px: 12,
  desktop_taskbar_padding_px: 10,
  desktop_taskbar_padding_y_px: 6,
  desktop_toolbar_padding_x_px: 12,
  desktop_toolbar_padding_y_px: 6,
  desktop_toast_visible_ms: 4000,
  desktop_toast_fade_ms: 1500,
  custom_wallpaper_available: false,
  custom_wallpaper_url: null,
  custom_wallpaper_content_type: null,
  updated_at: new Date(0).toISOString(),
};

export const bundledWallpapers: Record<Exclude<WallpaperChoice, 'custom'>, string> = {
  garage_empty: garageEmptyURL,
  garage_hotrod: garageHotrodURL,
};

export async function getUISettings(): Promise<UISettings> {
  const { data, error } = await api.GET('/settings/ui');
  if (error || !data) {
    throw new Error('Could not load appearance settings.');
  }
  return data;
}

export async function updateUISettings(input: UISettingsInput): Promise<UISettings> {
  const { data, error } = await api.PUT('/settings/ui', { body: input });
  if (error || !data) {
    throw new Error('Could not save appearance settings.');
  }
  return data;
}

export async function uploadCustomWallpaper(file: File): Promise<UISettings> {
  const headers = new Headers({ 'Content-Type': file.type || 'application/octet-stream' });
  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken) {
    headers.set(csrfHeaderName, decodeURIComponent(csrfToken));
  }
  const signedInit = await signRequestInit('/api/settings/wallpaper/custom', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: file,
  });
  const response = await fetch('/api/settings/wallpaper/custom', signedInit);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(typeof payload.error === 'string' ? payload.error : `Custom wallpaper upload failed: ${response.status}`);
  }
  return response.json() as Promise<UISettings>;
}

export function wallpaperURL(settings?: UISettings | null, surface: WallpaperSurface = 'public'): string {
  const current = settings ?? defaultUISettings;
  if (!current.wallpaper_overridden) {
    return surface === 'app' ? bundledWallpapers.garage_hotrod : bundledWallpapers.garage_empty;
  }
  if (current.wallpaper_choice === 'garage_hotrod') {
    return bundledWallpapers.garage_hotrod;
  }
  if (current.wallpaper_choice === 'custom' && current.custom_wallpaper_available && current.custom_wallpaper_url) {
    return current.custom_wallpaper_url;
  }
  return bundledWallpapers.garage_empty;
}

export function wallpaperDim(settings?: UISettings | null): number {
  const value = settings?.wallpaper_dim_percent ?? defaultUISettings.wallpaper_dim_percent;
  return Math.max(0, Math.min(95, value)) / 100;
}

export function normalizeDesktopToastVisibleMS(value?: number | null): number {
  const numeric = Number(value ?? defaultUISettings.desktop_toast_visible_ms);
  if (!Number.isFinite(numeric)) return defaultUISettings.desktop_toast_visible_ms;
  return Math.round(Math.max(1000, Math.min(30000, numeric)));
}

export function normalizeDesktopToastFadeMS(value?: number | null): number {
  const numeric = Number(value ?? defaultUISettings.desktop_toast_fade_ms);
  if (!Number.isFinite(numeric)) return defaultUISettings.desktop_toast_fade_ms;
  return Math.round(Math.max(250, Math.min(5000, numeric)));
}

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}
