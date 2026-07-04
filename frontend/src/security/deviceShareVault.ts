// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { api } from '../api/client';
import { storedDebugToken } from './debugAuth';
import { decryptDeviceShare, encryptDeviceShareForPublicKey, registerDeviceEnvelopeKey } from './deviceEnvelopeVault';

const databaseName = 'shellorchestra-device-share-vault';
const storeName = 'device-share';
const recordID = 'current';

type VaultRecord = {
  id: string;
  key: CryptoKey;
  iv_b64: string;
  ciphertext_b64: string;
  created_at: string;
};


type KeyDeliveryDevice = {
  device_id: string;
  label?: string | null;
  envelope_public_key_spki_b64?: string | null;
};

type KeyDeliveryShare = {
  device_id: string;
  epoch: number;
  encrypted_device_share_b64: string;
};

export type RuntimeUnlockResult = {
  unlocked: boolean;
  message: string;
};

export type RuntimeUnlockDebugEvent = {
  at: string;
  step: string;
  message: string;
  details?: Record<string, unknown>;
};

export type RuntimeUnlockDebugOptions = {
  enabled?: boolean;
  onEvent?: (event: RuntimeUnlockDebugEvent) => void;
};

function emitRuntimeUnlockDebug(options: RuntimeUnlockDebugOptions | undefined, step: string, message: string, details?: Record<string, unknown>) {
  if (!options?.enabled) return;
  const event: RuntimeUnlockDebugEvent = {
    at: new Date().toISOString(),
    step,
    message,
    details: details ? sanitizeDebugDetails(details) : undefined,
  };
  options.onEvent?.(event);
  console.info('[ShellOrchestra server-access unlock]', event);
}

function sanitizeDebugDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/share|token|secret|key|credential|ciphertext|payload/i.test(key)) {
      safe[key] = '[redacted]';
    } else if (value instanceof Error) {
      safe[key] = value.message;
    } else if (typeof value === 'string') {
      safe[key] = value.slice(0, 300);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      safe[key] = value;
    } else if (value === undefined) {
      safe[key] = undefined;
    } else {
      safe[key] = String(value).slice(0, 300);
    }
  }
  return safe;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail', 'title']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  return 'Unknown error';
}

function requireVaultSupport() {
  if (!('indexedDB' in window) || !window.indexedDB) {
    throw new Error('Cannot save this device server-access key share because IndexedDB is disabled. Use a normal browser profile with site storage enabled, then authorize this device again.');
  }
  if (!window.crypto?.subtle) {
    throw new Error('Cannot save this device server-access key share because WebCrypto is unavailable. Use a normal browser profile with secure HTTPS access, then authorize this device again.');
  }
}

function openDatabase(): Promise<IDBDatabase> {
  requireVaultSupport();
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Cannot open device server-access key storage.'));
    request.onblocked = () => reject(new Error('Cannot open device server-access key storage because another ShellOrchestra tab is blocking the upgrade. Close other tabs and retry.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Device server-access key storage request failed.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Device server-access key storage transaction failed.'));
    });
  } finally {
    database.close();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function saveDeviceShare(deviceShareB64: string) {
  const trimmed = deviceShareB64.trim();
  if (trimmed === '') {
    throw new Error('Cannot save an empty device server-access key share. Authorize this device again.');
  }
  requireVaultSupport();
  const key = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encodedShare = new TextEncoder().encode(trimmed);
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytesToArrayBuffer(iv) }, key, bytesToArrayBuffer(encodedShare));
  const record: VaultRecord = {
    id: recordID,
    key,
    iv_b64: bytesToBase64(iv),
    ciphertext_b64: bytesToBase64(new Uint8Array(ciphertext)),
    created_at: new Date().toISOString(),
  };
  await withStore('readwrite', (store) => store.put(record));
}

export async function loadDeviceShare(debug?: RuntimeUnlockDebugOptions): Promise<string | null> {
  emitRuntimeUnlockDebug(debug, 'local-share.lookup.start', 'Looking for a saved server-access key share in this browser profile.');
  const record = await withStore<VaultRecord | undefined>('readonly', (store) => store.get(recordID));
  if (!record) {
    emitRuntimeUnlockDebug(debug, 'local-share.lookup.missing', 'This browser profile does not have a saved server-access key share.');
    return null;
  }
  emitRuntimeUnlockDebug(debug, 'local-share.lookup.found', 'This browser profile has a saved encrypted server-access key share.', { createdAt: record.created_at });
  try {
    const plaintext = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(base64ToBytes(record.iv_b64)) },
      record.key,
      bytesToArrayBuffer(base64ToBytes(record.ciphertext_b64)),
    );
    emitRuntimeUnlockDebug(debug, 'local-share.decrypt.ok', 'The saved browser key share decrypted successfully.');
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    emitRuntimeUnlockDebug(debug, 'local-share.decrypt.failed', 'The saved browser key share could not be decrypted.', { error: errorMessage(error) });
    throw error;
  }
}


export async function syncDeviceShareFromServer(debug?: RuntimeUnlockDebugOptions): Promise<string | null> {
  emitRuntimeUnlockDebug(debug, 'server-share.fetch.start', 'Checking whether the backend has a fresh encrypted key share for this device.');
  const { data, error } = await api.GET('/keys/device-share');
  if (error || !data?.encrypted_device_share_b64) {
    emitRuntimeUnlockDebug(debug, 'server-share.fetch.missing', 'No deliverable encrypted key share was returned for this device.', {
      hasError: Boolean(error),
      error: error ? errorMessage(error) : undefined,
      hasPayload: Boolean(data?.encrypted_device_share_b64),
    });
    return null;
  }
  emitRuntimeUnlockDebug(debug, 'server-share.fetch.ok', 'The backend returned an encrypted key share for this device.');
  try {
    const deviceShare = await decryptDeviceShare(data.encrypted_device_share_b64);
    emitRuntimeUnlockDebug(debug, 'server-share.decrypt.ok', 'This browser decrypted the delivered key share successfully.');
    await saveDeviceShare(deviceShare);
    emitRuntimeUnlockDebug(debug, 'server-share.save.ok', 'The delivered key share was saved in this browser profile.');
    return deviceShare;
  } catch (error) {
    emitRuntimeUnlockDebug(debug, 'server-share.decrypt.failed', 'This browser could not decrypt the delivered key share.', { error: errorMessage(error) });
    throw error;
  }
}

export async function unlockRuntimeWithDeviceShare(deviceShareB64: string, debug?: RuntimeUnlockDebugOptions): Promise<RuntimeUnlockResult> {
  emitRuntimeUnlockDebug(debug, 'runtime-unlock.request.start', 'Sending a server-access unlock request from this trusted device.');
  const { data, error } = await api.POST('/runtime/unlock', { body: { device_share_b64: deviceShareB64 } });
  if (error) {
    emitRuntimeUnlockDebug(debug, 'runtime-unlock.request.failed', 'The backend rejected the unlock request.', { error: errorMessage(error) });
    throw new Error('Server access could not be unlocked from this trusted device. Authorize this device again, or use another trusted device that has the current server-access keys.');
  }
  const result = { unlocked: data?.locked === false, message: data?.message ?? 'Server access is unlocked.' };
  emitRuntimeUnlockDebug(debug, result.unlocked ? 'runtime-unlock.request.ok' : 'runtime-unlock.request.still-locked', result.message, { unlocked: result.unlocked });
  return result;
}

export async function unlockRuntimeWithDebugToken(debug?: RuntimeUnlockDebugOptions): Promise<RuntimeUnlockResult | null> {
  const token = storedDebugToken();
  if (!token) {
    return null;
  }
  emitRuntimeUnlockDebug(debug, 'debug-runtime-unlock.request.start', 'Trying debug-only server-access unlock for this development browser profile.');
  const { data, error } = await api.POST('/debug/runtime-unlock', { body: { token } });
  if (error) {
    emitRuntimeUnlockDebug(debug, 'debug-runtime-unlock.request.failed', 'Debug-only server-access unlock is not available for this browser profile right now.', { error: errorMessage(error) });
    return null;
  }
  const result = { unlocked: data?.locked === false, message: data?.message ?? 'Server access is unlocked.' };
  emitRuntimeUnlockDebug(debug, result.unlocked ? 'debug-runtime-unlock.request.ok' : 'debug-runtime-unlock.request.still-locked', result.message, { unlocked: result.unlocked });
  return result;
}

export async function publishCurrentDeviceShareIfAvailable(deviceShareB64?: string | null, debug?: RuntimeUnlockDebugOptions): Promise<boolean> {
  emitRuntimeUnlockDebug(debug, 'key-delivery.publish.start', 'Checking whether this device can refresh server-access key delivery for trusted devices.');
  const deviceShare = deviceShareB64?.trim() || await loadDeviceShare(debug);
  if (!deviceShare) {
    emitRuntimeUnlockDebug(debug, 'key-delivery.publish.skipped', 'No current key share is available for encrypted key delivery.');
    return false;
  }
  const { data: status, error: statusError } = await api.GET('/keys/status');
  if (statusError || !status?.initialized || status.active_epoch <= 0 || status.auth_mode !== 'passkey') {
    emitRuntimeUnlockDebug(debug, 'key-delivery.publish.skipped', 'Current server-access key status does not require key-delivery refresh for this browser.', {
      hasError: Boolean(statusError),
      error: statusError ? errorMessage(statusError) : undefined,
      initialized: Boolean(status?.initialized),
      activeEpoch: status?.active_epoch ?? 0,
      authMode: status?.auth_mode ?? 'unknown',
    });
    return false;
  }
  const currentDeviceID = String(status.current_device_id ?? '');
  const currentEnvelopePublicKeySPKIB64 = await registerDeviceEnvelopeKey();
  emitRuntimeUnlockDebug(debug, 'key-delivery.envelope-key.ok', 'This browser has a registered key-delivery public key.');

  const devices = Array.isArray(status.devices) ? status.devices as KeyDeliveryDevice[] : [];
  const shares: KeyDeliveryShare[] = [];
  for (const device of devices) {
    const deviceID = String(device.device_id ?? '').trim();
    if (!deviceID) continue;
    const envelopePublicKeySPKIB64 = (device.envelope_public_key_spki_b64 || (deviceID === currentDeviceID ? currentEnvelopePublicKeySPKIB64 : '')).trim();
    if (!envelopePublicKeySPKIB64) continue;
    shares.push({
      device_id: deviceID,
      epoch: status.active_epoch,
      encrypted_device_share_b64: await encryptDeviceShareForPublicKey(deviceShare, envelopePublicKeySPKIB64),
    });
  }

  if (shares.length === 0) {
    emitRuntimeUnlockDebug(debug, 'key-delivery.publish.skipped', 'No trusted devices have registered key-delivery public keys yet.', { activeEpoch: status.active_epoch });
    return false;
  }

  emitRuntimeUnlockDebug(debug, 'key-delivery.distribute.start', 'Publishing fresh encrypted server-access key shares for trusted devices.', {
    activeEpoch: status.active_epoch,
    deviceCount: shares.length,
  });
  const { data, error } = await api.POST('/keys/device-shares', { body: { shares } });
  if (error) {
    emitRuntimeUnlockDebug(debug, 'key-delivery.publish.failed', 'ShellOrchestra could not save encrypted key-delivery copies for trusted devices.', { error: errorMessage(error) });
    throw new Error('This device unlocked server access, but ShellOrchestra could not refresh encrypted key delivery for trusted devices.');
  }
  emitRuntimeUnlockDebug(debug, 'key-delivery.distribute.ok', 'Fresh encrypted server-access key shares were saved for trusted devices.', {
    activeEpoch: status.active_epoch,
    storedDevices: typeof data?.stored === 'number' ? data.stored : shares.length,
  });
  return true;
}

export async function saveDeviceShareAndUnlock(deviceShareB64: string, debug?: RuntimeUnlockDebugOptions): Promise<RuntimeUnlockResult> {
  await saveDeviceShare(deviceShareB64);
  emitRuntimeUnlockDebug(debug, 'local-share.save.ok', 'The new server-access key share was saved in this browser profile.');
  const result = await unlockRuntimeWithDeviceShare(deviceShareB64, debug);
  if (result.unlocked) {
    await publishCurrentDeviceShareIfAvailable(deviceShareB64, debug);
  }
  return result;
}

export async function unlockRuntimeFromSavedDeviceShare(debug?: RuntimeUnlockDebugOptions): Promise<RuntimeUnlockResult> {
  emitRuntimeUnlockDebug(debug, 'auto-unlock.start', 'Starting automatic server-access unlock from this browser.');
  let deviceShare: string | null = null;
  let serverShareError: unknown = null;
  try {
    deviceShare = await syncDeviceShareFromServer(debug);
  } catch (error) {
    serverShareError = error;
    emitRuntimeUnlockDebug(
      debug,
      'server-share.unusable',
      'The backend returned a key-delivery copy, but this browser could not use it. Trying this browser profile’s local protected key share next.',
      { error: errorMessage(error) },
    );
  }
  const usingDeliveredShare = Boolean(deviceShare);
  deviceShare = deviceShare ?? await loadDeviceShare(debug);
  if (!deviceShare) {
    const debugUnlock = await unlockRuntimeWithDebugToken(debug);
    if (debugUnlock?.unlocked) {
      return debugUnlock;
    }
    emitRuntimeUnlockDebug(debug, 'auto-unlock.no-share', 'Automatic unlock cannot continue because this browser has no usable current key share.');
    return {
      unlocked: false,
      message: serverShareError
        ? 'This device is authorized, but ShellOrchestra could not use either the backend-delivered key copy or this browser profile’s local key share. Authorize this browser again from the primary phone so it receives fresh server-access keys.'
        : 'This device is authorized, but it does not have the current server-access key share. Open ShellOrchestra on any trusted device that already has the current server-access keys. If no trusted device can unlock server access, open Keys on a desktop, create or rotate server-access keys, and approve the change with the primary approval phone so fresh shares are delivered automatically.',
    };
  }
  emitRuntimeUnlockDebug(debug, 'auto-unlock.share-selected', usingDeliveredShare ? 'Using the freshly delivered key share from the backend.' : 'Using the saved key share from this browser profile.');
  try {
    const result = await unlockRuntimeWithDeviceShare(deviceShare, debug);
    if (result.unlocked) {
      await publishCurrentDeviceShareIfAvailable(deviceShare, debug);
    }
    return result;
  } catch (error) {
    emitRuntimeUnlockDebug(debug, 'auto-unlock.retry.start', 'The first unlock attempt failed. Checking for a newly delivered key share before giving up.', { error: errorMessage(error) });
    const refreshedShare = await syncDeviceShareFromServer(debug);
    if (refreshedShare && refreshedShare !== deviceShare) {
      emitRuntimeUnlockDebug(debug, 'auto-unlock.retry.share-selected', 'Retrying unlock with a newly delivered key share.');
      const result = await unlockRuntimeWithDeviceShare(refreshedShare, debug);
      if (result.unlocked) {
        await publishCurrentDeviceShareIfAvailable(refreshedShare, debug);
      }
      return result;
    }
    emitRuntimeUnlockDebug(debug, 'auto-unlock.failed', 'Automatic server-access unlock failed for this browser.', { error: errorMessage(error) });
    throw error;
  }
}
