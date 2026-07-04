// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

const databaseName = 'shellorchestra-device-envelope-vault';
const storeName = 'envelope-key';
const recordID = 'current';
const csrfCookieName = 'shellorchestra_csrf';
const csrfHeaderName = 'X-ShellOrchestra-CSRF';

type EnvelopeRecord = {
  id: string;
  privateKey: CryptoKey;
  publicKeySPKIB64: string;
  createdAt: string;
};

type APIError = { error?: string };

function requireEnvelopeSupport() {
  if (!('indexedDB' in window) || !window.indexedDB) {
    throw new Error('Device key delivery needs browser storage. Enable site storage and retry.');
  }
  if (!window.crypto?.subtle) {
    throw new Error('Device key delivery needs WebCrypto. Open ShellOrchestra over trusted HTTPS and retry.');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

function openDatabase(): Promise<IDBDatabase> {
  requireEnvelopeSupport();
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Cannot open device key delivery storage.'));
    request.onblocked = () => reject(new Error('Device key delivery storage is blocked by another ShellOrchestra tab. Close other tabs and retry.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Device key delivery storage request failed.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Device key delivery storage transaction failed.'));
    });
  } finally {
    database.close();
  }
}

async function loadEnvelopeRecord(): Promise<EnvelopeRecord | undefined> {
  return withStore<EnvelopeRecord | undefined>('readonly', (store) => store.get(recordID));
}

export async function ensureDeviceEnvelopeKey(): Promise<string> {
  requireEnvelopeSupport();
  const existing = await loadEnvelopeRecord();
  if (existing?.publicKeySPKIB64) {
    return existing.publicKeySPKIB64;
  }
  const keyPair = await window.crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['encrypt', 'decrypt'],
  ) as CryptoKeyPair;
  const publicKeySPKI = await window.crypto.subtle.exportKey('spki', keyPair.publicKey);
  const publicKeySPKIB64 = bytesToBase64(new Uint8Array(publicKeySPKI));
  await withStore('readwrite', (store) => store.put({ id: recordID, privateKey: keyPair.privateKey, publicKeySPKIB64, createdAt: new Date().toISOString() } satisfies EnvelopeRecord));
  return publicKeySPKIB64;
}

export async function registerDeviceEnvelopeKey(): Promise<string> {
  const envelopePublicKeySPKIB64 = await ensureDeviceEnvelopeKey();
  const csrfToken = readCookie(csrfCookieName);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrfToken) {
    headers.set(csrfHeaderName, decodeURIComponent(csrfToken));
  }
  const response = await fetch('/api/auth/device-envelope-key', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ envelope_public_key_spki_b64: envelopePublicKeySPKIB64 }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as APIError;
    throw new Error(typeof payload.error === 'string' ? payload.error : `Device protection update failed: ${response.status}`);
  }
  return envelopePublicKeySPKIB64;
}

export async function encryptDeviceShareForPublicKey(deviceShareB64: string, publicKeySPKIB64: string): Promise<string> {
  const publicKey = await window.crypto.subtle.importKey(
    'spki',
    bytesToArrayBuffer(base64ToBytes(publicKeySPKIB64)),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, new TextEncoder().encode(deviceShareB64));
  return bytesToBase64(new Uint8Array(ciphertext));
}

export async function decryptDeviceShare(encryptedDeviceShareB64: string): Promise<string> {
  const record = await loadEnvelopeRecord();
  if (!record) {
    throw new Error('This browser is trusted for sign-in, but it is missing the local key-delivery private key needed to read server-access keys. Log out, open the sign-in page, choose “This is a new device — Request authorization”, and approve it from the primary phone so this browser receives fresh server-access keys.');
  }
  const plaintext = await window.crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    record.privateKey,
    bytesToArrayBuffer(base64ToBytes(encryptedDeviceShareB64)),
  );
  return new TextDecoder().decode(plaintext);
}
