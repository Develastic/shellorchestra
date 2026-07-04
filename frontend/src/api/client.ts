// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import createClient from 'openapi-fetch';
import type { paths } from './schema';
import { signRequestInit } from '../security/requestSigning';
import { addUserActivityHeader, noteSessionRefresh } from '../security/sessionActivity';

const csrfCookieName = 'shellorchestra_csrf';
const csrfHeaderName = 'X-ShellOrchestra-CSRF';
const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken && mutatingMethods.has(method)) {
    headers.set(csrfHeaderName, decodeURIComponent(csrfToken));
  }
  const carriedUserActivity = addUserActivityHeader(headers);
  const signedInit = await signRequestInit(input, {
    ...init,
    credentials: 'include',
    headers,
  });
  const response = await fetch(fetchURL(input), signedInit);
  if (carriedUserActivity && response.ok) {
    noteSessionRefresh();
  }
  if (response.status === 401 && shouldRedirectToLogin(input)) {
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }
  return response;
}

function fetchURL(input: RequestInfo | URL): RequestInfo | URL {
  if (input instanceof Request) {
    return input.url;
  }
  return input;
}

function shouldRedirectToLogin(input: RequestInfo | URL): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.pathname === '/login' || window.location.pathname === '/debug-login' || window.location.pathname.startsWith('/setup/phone') || window.location.pathname === '/approve/key-change' || window.location.pathname === '/k') {
    return false;
  }
  const path = requestPath(input);
  if (path === '/api/auth/me') return false;
  if (path === '/api/bootstrap/state' || path === '/api/healthz') return false;
  if (path === '/api/auth/debug/login') return false;
  if (path.startsWith('/api/auth/passkey/') || path.startsWith('/api/auth/lan/')) return false;
  return true;
}

function requestPath(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url, window.location.origin).pathname;
  }
  if (input instanceof URL) {
    return input.pathname;
  }
  return new URL(input, window.location.origin).pathname;
}

export const api = createClient<paths>({
  baseUrl: '/api',
  credentials: 'include',
  fetch: apiFetch,
});
