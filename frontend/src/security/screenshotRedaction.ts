// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { debugSupportCompiled } from '../debug/buildFlags';

let debugScreenshotRedactionEnabled = false;

export function setDebugScreenshotRedactionEnabled(enabled: boolean) {
  debugScreenshotRedactionEnabled = debugSupportCompiled && enabled;
}

export function isDebugScreenshotRedactionEnabled(): boolean {
  return debugSupportCompiled && debugScreenshotRedactionEnabled;
}

export function redactDebugScreenshotText(value: string): string {
  if (!isDebugScreenshotRedactionEnabled()) return value;
  return redactSensitiveText(value);
}

export function redactSensitiveText(value: string): string {
  if (!value) return value;
  return redactIPv6(redactIPv4(redactTailscaleMagicDNS(value)));
}

export function redactDebugScreenshotUnknown(value: unknown): unknown {
  if (!isDebugScreenshotRedactionEnabled()) return value;
  return redactSensitiveUnknown(value, 0);
}

function redactSensitiveUnknown(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth > 4) return '[max-depth]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveUnknown(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSensitiveUnknown(child, depth + 1);
    }
    return out;
  }
  return value;
}

function redactTailscaleMagicDNS(value: string): string {
  return value.replace(/\b(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net\b/gi, '<hidden>.ts.net');
}

function redactIPv4(value: string): string {
  return value.replace(/(^|[^\w.])((?:\d{1,3}\.){3}\d{1,3})(?![\w.])/g, (match, prefix: string, candidate: string) => {
    const parsed = parseIPv4(candidate);
    if (!parsed) return match;
    if (!isSensitiveIPv4(parsed)) return match;
    return `${prefix}<hidden-ipv4>`;
  });
}

function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null;
  return nums as [number, number, number, number];
}

function isSensitiveIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 127 || a === 0) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 2) return false;
  if (a === 198 && b === 51) return false;
  if (a === 203 && b === 0) return false;
  if (a >= 224) return false;
  return true;
}

function redactIPv6(value: string): string {
  const bracketed = value.replace(/\[([0-9a-f:.]+:[0-9a-f:.]+(?:%[0-9a-z_.-]+)?)\]/gi, (_match, candidate: string) => {
    return isSensitiveIPv6(candidate) ? '[<hidden-ipv6>]' : `[${candidate}]`;
  });
  const zoned = bracketed.replace(/(^|[^\w:])([0-9a-f]{0,4}:[0-9a-f:.]{2,}[0-9a-f]%[0-9a-z_.-]+)(?=:\d+\b|[^\w:%]|$)/gi, (match, prefix: string, candidate: string) => {
    if (!isSensitiveIPv6(candidate)) return match;
    return `${prefix}<hidden-ipv6>`;
  });
  return zoned.replace(/(^|[^\w:])([0-9a-f]{0,4}:[0-9a-f:.]{2,}[0-9a-f])(?![\w:%])/gi, (match, prefix: string, candidate: string) => {
    if (!isSensitiveIPv6(candidate)) return match;
    return `${prefix}<hidden-ipv6>`;
  });
}

function isSensitiveIPv6(value: string): boolean {
  const withoutZone = value.split('%', 1)[0].toLowerCase();
  if (!withoutZone.includes(':')) return false;
  if (!/^[0-9a-f:.]+$/.test(withoutZone)) return false;
  if (withoutZone === '::1' || withoutZone === '::') return false;
  if (withoutZone.startsWith('ff')) return false;
  if (withoutZone.startsWith('2001:db8:') || withoutZone === '2001:db8::') return false;
  return true;
}
