// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

const databaseName = 'shellorchestra-request-signing-vault';
const storeName = 'request-signing-keys';
const recordID = 'current';
const csrfCookieName = 'shellorchestra_csrf';
const csrfHeaderName = 'X-ShellOrchestra-CSRF';
const sessionStorageKey = 'shellorchestra.requestSigningSession.v1';

const publicOrBootstrapPaths = [
  '/api/healthz',
  '/api/bootstrap/state',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/debug/login',
  '/api/auth/device-signing-key',
  '/api/auth/device-envelope-key',
];

const publicPrefixes = [
  '/api/auth/passkey/',
  '/api/auth/lan/',
  '/api/auth/device-requests/',
];

type SigningRecord = {
  id: string;
  deviceID: string;
  privateKey: CryptoKey;
  publicKeySPKIB64: string;
  createdAt: string;
  registeredAt?: string;
};

type Principal = {
  device_id: string;
  label: string;
  kind: 'phone' | 'desktop' | 'browser';
  can_approve_device_requests: boolean;
};

type APIError = { error?: string };

let registrationInFlight: Promise<void> | null = null;

export function shouldSignAPIRequest(input: RequestInfo | URL): boolean {
  if (typeof window === 'undefined') return false;
  const path = requestPath(input);
  if (!path.startsWith('/api/')) return false;
  if (publicOrBootstrapPaths.includes(path)) return false;
  return !publicPrefixes.some((prefix) => path.startsWith(prefix));
}

export async function signRequestInit(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit> {
  if (!shouldSignAPIRequest(input)) {
    return init ?? {};
  }
  const record = await loadSigningRecord();
  if (!record) {
    throw new Error('This device has no request signing key yet. Sign in again so ShellOrchestra can register this browser securely.');
  }
  const preparedBody = await bodyToUint8Array(input, init?.body);
  const bodyHash = await bodyHashBase64URL(preparedBody.bytes);
  const timestamp = new Date().toISOString();
  const nonce = randomBase64URL(18);
  const sessionID = requestSigningSessionID();
  const pathQuery = requestPathQuery(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const canonical = [method, pathQuery, bodyHash, timestamp, nonce, record.deviceID, sessionID].join('\n');
  const signature = await window.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    record.privateKey,
    new TextEncoder().encode(canonical),
  );
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('X-ShellOrchestra-Device-ID', record.deviceID);
  headers.set('X-ShellOrchestra-Session-ID', sessionID);
  headers.set('X-ShellOrchestra-Timestamp', timestamp);
  headers.set('X-ShellOrchestra-Nonce', nonce);
  headers.set('X-ShellOrchestra-Body-SHA256', bodyHash);
  headers.set('X-ShellOrchestra-Signature', bytesToBase64URL(new Uint8Array(signature)));
  return {
    ...init,
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : preparedBody.body,
  };
}

export async function ensureDeviceSigningKeyRegistered(deviceID?: string | null): Promise<void> {
  const normalizedDeviceID = deviceID?.trim() || (await currentPrincipalDeviceID());
  if (!normalizedDeviceID) {
    throw new Error('ShellOrchestra signed in, but the backend did not return a device identity. Sign in again.');
  }
  if (registrationInFlight) {
    await registrationInFlight;
    return;
  }
  registrationInFlight = registerDeviceSigningKey(normalizedDeviceID).finally(() => {
    registrationInFlight = null;
  });
  await registrationInFlight;
}

async function registerDeviceSigningKey(deviceID: string): Promise<void> {
  const record = await loadOrCreateSigningRecord(deviceID);
  const csrfToken = readCookie(csrfCookieName);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrfToken) {
    headers.set(csrfHeaderName, decodeURIComponent(csrfToken));
  }
  const response = await fetch('/api/auth/device-signing-key', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ public_key_spki_b64: record.publicKeySPKIB64 }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as APIError;
    throw new Error(typeof payload.error === 'string' ? payload.error : `Device request signing setup failed: ${response.status}`);
  }
  await saveSigningRecord({ ...record, registeredAt: new Date().toISOString() });
}

async function currentPrincipalDeviceID(): Promise<string> {
  const response = await fetch('/api/auth/me', { credentials: 'include' });
  if (!response.ok) return '';
  const principal = (await response.json().catch(() => ({}))) as Partial<Principal>;
  return typeof principal.device_id === 'string' ? principal.device_id : '';
}

async function loadOrCreateSigningRecord(deviceID: string): Promise<SigningRecord> {
  const existing = await loadSigningRecord();
  if (existing?.deviceID === deviceID) {
    return existing;
  }
  const keyPair = await generateNonExtractableSigningKeyPair();
  const publicKeySPKI = await window.crypto.subtle.exportKey('spki', keyPair.publicKey);
  return {
    id: recordID,
    deviceID,
    privateKey: keyPair.privateKey,
    publicKeySPKIB64: bytesToBase64(new Uint8Array(publicKeySPKI)),
    createdAt: new Date().toISOString(),
  };
}

async function generateNonExtractableSigningKeyPair(): Promise<CryptoKeyPair> {
  requireSigningSupport();
  return (await window.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

function requireSigningSupport() {
  if (!('indexedDB' in window) || !window.indexedDB) {
    throw new Error('Request signing needs browser storage. Enable site storage and sign in again.');
  }
  if (!window.crypto?.subtle) {
    throw new Error('Request signing needs WebCrypto. Open ShellOrchestra over trusted HTTPS and sign in again.');
  }
}

async function bodyToUint8Array(input: RequestInfo | URL, body?: BodyInit | null): Promise<{ bytes: Uint8Array; body?: BodyInit | null }> {
  const effectiveBody = body ?? null;
  if (effectiveBody === null) {
    if (input instanceof Request && input.body && !['GET', 'HEAD'].includes(input.method.toUpperCase())) {
      const bytes = new Uint8Array(await input.clone().arrayBuffer());
      return { bytes, body: bytes };
    }
    return { bytes: new Uint8Array(), body: effectiveBody };
  }
  if (typeof effectiveBody === 'string') {
    return { bytes: new TextEncoder().encode(effectiveBody), body: effectiveBody };
  }
  if (effectiveBody instanceof Blob) {
    return { bytes: new Uint8Array(await effectiveBody.arrayBuffer()), body: effectiveBody };
  }
  if (effectiveBody instanceof URLSearchParams) {
    const encoded = effectiveBody.toString();
    return { bytes: new TextEncoder().encode(encoded), body: effectiveBody };
  }
  if (effectiveBody instanceof FormData) {
    throw new Error('Signed uploads must send a raw file body. Multipart FormData cannot be signed reliably by this browser.');
  }
  if (effectiveBody instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(effectiveBody), body: effectiveBody };
  }
  if (ArrayBuffer.isView(effectiveBody)) {
    const view = effectiveBody as ArrayBufferView;
    return {
      bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      body: effectiveBody,
    };
  }
  throw new Error('This request body type cannot be signed safely.');
}

async function bodyHashBase64URL(bytes: Uint8Array): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', bytesToArrayBuffer(bytes));
  return bytesToBase64URL(new Uint8Array(digest));
}

function requestPath(input: RequestInfo | URL): string {
  return requestURL(input).pathname;
}

function requestPathQuery(input: RequestInfo | URL): string {
  const url = requestURL(input);
  return `${url.pathname}${url.search}`;
}

function requestURL(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    return new URL(input.url, window.location.origin);
  }
  if (input instanceof URL) {
    return new URL(input.toString(), window.location.origin);
  }
  return new URL(input, window.location.origin);
}

function requestSigningSessionID(): string {
  const existing = window.sessionStorage.getItem(sessionStorageKey)?.trim();
  if (existing) return existing;
  const generated = randomBase64URL(18);
  window.sessionStorage.setItem(sessionStorageKey, generated);
  return generated;
}

function openDatabase(): Promise<IDBDatabase> {
  requireSigningSupport();
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Cannot open request signing storage.'));
    request.onblocked = () => reject(new Error('Request signing storage is blocked by another ShellOrchestra tab. Close other tabs and retry.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Request signing storage operation failed.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Request signing storage transaction failed.'));
    });
  } finally {
    database.close();
  }
}

async function loadSigningRecord(): Promise<SigningRecord | null> {
  return (await withStore<SigningRecord | undefined>('readonly', (store) => store.get(recordID))) ?? null;
}

async function saveSigningRecord(record: SigningRecord): Promise<void> {
  await withStore('readwrite', (store) => store.put(record));
}

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
}

function bytesToBase64URL(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function randomBase64URL(size: number): string {
  const bytes = window.crypto.getRandomValues(new Uint8Array(size));
  return bytesToBase64URL(bytes);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
