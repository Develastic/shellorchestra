// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

const userActivityWindowMs = 30_000;
const defaultSessionIdleTimeoutSeconds = 60 * 60;
const sessionWarningSeconds = 5 * 60;
const userActivityHeaderName = 'X-ShellOrchestra-User-Activity';

let sessionIdleTimeoutSeconds = defaultSessionIdleTimeoutSeconds;
let lastTrustedUserActivityAt = typeof Date !== 'undefined' ? Date.now() : 0;
let lastSessionRefreshAt = typeof Date !== 'undefined' ? Date.now() : 0;
let listenersInstalled = false;

export type SessionIdleSnapshot = {
  idleTimeoutSeconds: number;
  warningSeconds: number;
  lastTrustedUserActivityAt: number;
  lastSessionRefreshAt: number;
  expiresAt: number;
  remainingSeconds: number;
  warningActive: boolean;
  expired: boolean;
  refreshRecommended: boolean;
};

export function installUserActivityTracking(): void {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  const record = (event: Event) => {
    if ('isTrusted' in event && event.isTrusted === false) return;
    lastTrustedUserActivityAt = Date.now();
  };
  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const eventName of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus']) {
    window.addEventListener(eventName, record, options);
  }
}

export function configureSessionIdleTimeout(seconds?: number | null): void {
  const normalized = Math.trunc(Number(seconds));
  if (Number.isFinite(normalized) && normalized > 0) {
    sessionIdleTimeoutSeconds = normalized;
  } else {
    sessionIdleTimeoutSeconds = defaultSessionIdleTimeoutSeconds;
  }
  if (lastSessionRefreshAt <= 0) {
    lastSessionRefreshAt = Date.now();
  }
}

export function addUserActivityHeader(headers: Headers): boolean {
  installUserActivityTracking();
  if (trustedUserActivityIsRecent()) {
    headers.set(userActivityHeaderName, '1');
    return true;
  }
  return false;
}

export function noteSessionRefresh(maxAgeSeconds?: number | null): void {
  configureSessionIdleTimeout(maxAgeSeconds ?? sessionIdleTimeoutSeconds);
  lastSessionRefreshAt = Date.now();
}

export function getSessionIdleSnapshot(now = Date.now()): SessionIdleSnapshot {
  const idleTimeoutMs = sessionIdleTimeoutSeconds * 1000;
  const expiresAt = lastSessionRefreshAt + idleTimeoutMs;
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const warningWindowSeconds = Math.min(sessionWarningSeconds, Math.max(15, Math.floor(sessionIdleTimeoutSeconds / 2)));
  const refreshThresholdMs = Math.max(10_000, Math.min(60_000, Math.floor(idleTimeoutMs / 4)));
  return {
    idleTimeoutSeconds: sessionIdleTimeoutSeconds,
    warningSeconds: warningWindowSeconds,
    lastTrustedUserActivityAt,
    lastSessionRefreshAt,
    expiresAt,
    remainingSeconds,
    warningActive: remainingSeconds > 0 && remainingSeconds <= warningWindowSeconds,
    expired: remainingSeconds <= 0,
    refreshRecommended: lastTrustedUserActivityAt > lastSessionRefreshAt && now - lastSessionRefreshAt >= refreshThresholdMs,
  };
}

export async function refreshSessionAfterTrustedActivity(): Promise<boolean> {
  installUserActivityTracking();
  const headers = new Headers();
  headers.set(userActivityHeaderName, '1');
  const response = await fetch('/api/auth/me', {
    method: 'GET',
    credentials: 'include',
    headers,
  });
  if (!response.ok) return false;
  const payload = (await response.json().catch(() => ({}))) as { session_idle_timeout_seconds?: number };
  noteSessionRefresh(payload.session_idle_timeout_seconds);
  return true;
}

function trustedUserActivityIsRecent(now = Date.now()): boolean {
  return now - lastTrustedUserActivityAt <= userActivityWindowMs;
}
