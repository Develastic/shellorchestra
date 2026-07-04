// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { signRequestInit } from '../security/requestSigning';
import { redactSensitiveText } from '../security/screenshotRedaction';
import { debugSupportCompiled } from './buildFlags';

const csrfCookieName = 'shellorchestra_csrf';
const csrfHeaderName = 'X-ShellOrchestra-CSRF';

type ClientDebugEvent = {
  at: string;
  step: string;
  message: string;
  details?: Record<string, unknown>;
};

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

export function sendClientDebugEvent(source: string, event: ClientDebugEvent, enabled: boolean) {
  if (!debugSupportCompiled || !enabled) return;
  void postClientDebugEvents(source, [event]).catch((error) => {
    console.warn('[ShellOrchestra client-debug upload failed]', error instanceof Error ? error.message : error);
  });
}

async function postClientDebugEvents(source: string, events: ClientDebugEvent[]) {
  const body = JSON.stringify({
    source: source.slice(0, 120),
    events: events.map(sanitizeEvent),
  });
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken) {
    headers.set(csrfHeaderName, decodeURIComponent(csrfToken));
  }
  const signedInit = await signRequestInit('/api/debug/client-events', {
    method: 'POST',
    credentials: 'include',
    headers,
    body,
  });
  const response = await fetch('/api/debug/client-events', signedInit);
  if (!response.ok && response.status !== 404) {
    throw new Error(`debug event upload failed: ${response.status}`);
  }
}

function sanitizeEvent(event: ClientDebugEvent): ClientDebugEvent {
  return {
    at: String(event.at).slice(0, 80),
    step: String(event.step).slice(0, 160),
    message: redactSensitiveText(String(event.message)).slice(0, 800),
    details: sanitizeDetails(event.details ?? {}),
  };
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    safe[key.slice(0, 120)] = sanitizeValue(key, value, 0);
  }
  return safe;
}

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (/share|token|secret|key|credential|ciphertext|payload|passkey/i.test(key)) {
    return '[redacted]';
  }
  if (depth > 2) return '[max-depth]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeValue(key, item, depth + 1));
  if (value && typeof value === 'object') {
    const safe: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      safe[childKey.slice(0, 120)] = sanitizeValue(childKey, childValue, depth + 1);
    }
    return safe;
  }
  if (value === undefined) return undefined;
  return String(value).slice(0, 500);
}
