// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { components } from '../api/schema';
import { signRequestInit } from '../security/requestSigning';

export type DesktopWallpaper = components['schemas']['VirtualDesktopWallpaper'];

const csrfCookieName = 'shellorchestra_csrf';
const csrfHeaderName = 'X-ShellOrchestra-CSRF';

export async function listDesktopWallpapers(): Promise<DesktopWallpaper[]> {
  const response = await signedJSONRequest<components['schemas']['VirtualDesktopWallpaperList']>('/api/desktop-wallpapers');
  return (response.wallpapers ?? []).map(normalizeDesktopWallpaperRecord).filter((item): item is DesktopWallpaper => Boolean(item));
}

export async function uploadDesktopWallpaper(file: File): Promise<DesktopWallpaper> {
  const label = encodeURIComponent(file.name.replace(/\.[^.]+$/, '').trim() || 'Custom wallpaper');
  const uploaded = await signedJSONRequest<DesktopWallpaper>(`/api/desktop-wallpapers?label=${label}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const normalized = normalizeDesktopWallpaperRecord(uploaded);
  if (!normalized) {
    throw new Error('ShellOrchestra uploaded the wallpaper but returned an invalid wallpaper record.');
  }
  return normalized;
}

export async function deleteDesktopWallpaper(id: string): Promise<void> {
  await signedJSONRequest<void>(`/api/desktop-wallpapers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function signedJSONRequest<TResponse>(url: string, init?: RequestInit): Promise<TResponse> {
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? 'GET').toUpperCase();
  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken && method !== 'GET') {
    headers.set(csrfHeaderName, decodeURIComponent(csrfToken));
  }
  const signedInit = await signRequestInit(url, {
    ...init,
    credentials: 'include',
    headers,
  });
  const response = await fetch(url, signedInit);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(typeof payload.error === 'string' ? payload.error : `Request failed: ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as TResponse;
  }
  return response.json() as Promise<TResponse>;
}

function normalizeDesktopWallpaperRecord(value: unknown): DesktopWallpaper | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DesktopWallpaper>;
  if (typeof candidate.id !== 'string' || typeof candidate.url !== 'string') return null;
  return {
    id: candidate.id,
    label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : 'Custom wallpaper',
    content_type: typeof candidate.content_type === 'string' ? candidate.content_type : '',
    source: typeof candidate.source === 'string' ? candidate.source : 'upload',
    url: candidate.url,
    created_at: typeof candidate.created_at === 'string' ? candidate.created_at : '',
    updated_at: typeof candidate.updated_at === 'string' ? candidate.updated_at : '',
  };
}

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}
