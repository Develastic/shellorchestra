// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type BrowserBinaryStreamProgress = {
  bytesDone: number;
  bytesTotal: number;
};

export type BrowserBinaryStreamSaveOptions = {
  name: string;
  mime?: string;
  bytesTotal?: number;
  signal?: AbortSignal;
  onProgress?: (progress: BrowserBinaryStreamProgress) => void;
};

export type BrowserBinaryStreamSaveResult = {
  blob?: Blob;
  bytesDone: number;
};

type BrowserFileSystemWritableFileStream = WritableStream<Uint8Array> & {
  abort?: () => Promise<void>;
  close: () => Promise<void>;
  write: (chunk: Uint8Array | Blob | string) => Promise<void>;
};

type BrowserFileSystemFileHandle = {
  createWritable: () => Promise<BrowserFileSystemWritableFileStream>;
};

type BrowserSaveFilePickerOptions = {
  suggestedName?: string;
};

export async function readBinaryResponseToBlob(response: Response, options: BrowserBinaryStreamSaveOptions): Promise<BrowserBinaryStreamSaveResult> {
  const mime = options.mime || response.headers.get('Content-Type') || 'application/octet-stream';
  const bytesTotal = normalizedTotal(options.bytesTotal ?? Number(response.headers.get('Content-Length') || '0'));
  if (!response.body) {
    const blob = await response.blob();
    options.onProgress?.({ bytesDone: blob.size, bytesTotal: bytesTotal || blob.size });
    return { blob, bytesDone: blob.size };
  }
  const chunks: BlobPart[] = [];
  const bytesDone = await readBinaryResponse(response, {
    ...options,
    bytesTotal,
    onChunk: async (chunk) => {
      chunks.push(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
    },
  });
  return { blob: new Blob(chunks, { type: mime }), bytesDone };
}

export async function saveBinaryResponseToBrowser(response: Response, options: BrowserBinaryStreamSaveOptions): Promise<BrowserBinaryStreamSaveResult> {
  const name = safeDownloadName(options.name);
  const bytesTotal = normalizedTotal(options.bytesTotal ?? Number(response.headers.get('Content-Length') || '0'));
  const picker = browserSaveFilePicker();
  if (picker && response.body) {
    const handle = await picker({ suggestedName: name });
    const writable = await handle.createWritable();
    try {
      const bytesDone = await readBinaryResponse(response, {
        ...options,
        bytesTotal,
        onChunk: async (chunk) => {
          await writable.write(chunk);
        },
      });
      await writable.close();
      return { bytesDone };
    } catch (error) {
      await writable.abort?.().catch(() => undefined);
      throw error;
    }
  }
  const result = await readBinaryResponseToBlob(response, { ...options, name, bytesTotal });
  if (result.blob) {
    triggerBrowserDownload(result.blob, name);
  }
  return result;
}

async function readBinaryResponse(response: Response, options: BrowserBinaryStreamSaveOptions & { onChunk: (chunk: Uint8Array) => Promise<void> }): Promise<number> {
  const bytesTotal = normalizedTotal(options.bytesTotal ?? Number(response.headers.get('Content-Length') || '0'));
  if (!response.body) {
    const blob = await response.blob();
    const buffer = new Uint8Array(await blob.arrayBuffer());
    await options.onChunk(buffer);
    options.onProgress?.({ bytesDone: buffer.byteLength, bytesTotal: bytesTotal || buffer.byteLength });
    return buffer.byteLength;
  }
  const reader = response.body.getReader();
  let done = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const part = await reader.read();
    if (part.done) break;
    await options.onChunk(part.value);
    done += part.value.byteLength;
    options.onProgress?.({ bytesDone: done, bytesTotal: bytesTotal || done });
  }
  return done;
}

function browserSaveFilePicker(): ((options: BrowserSaveFilePickerOptions) => Promise<BrowserFileSystemFileHandle>) | null {
  const candidate = (window as Window & { showSaveFilePicker?: (options: BrowserSaveFilePickerOptions) => Promise<BrowserFileSystemFileHandle> }).showSaveFilePicker;
  return typeof candidate === 'function' ? candidate.bind(window) : null;
}

function triggerBrowserDownload(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = safeDownloadName(name);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function safeDownloadName(value: string): string {
  const basename = (value || '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const trimmed = basename
    .replace(/[\x00-\x1f\x7f]/g, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const candidate = trimmed.slice(0, 180) || 'download.bin';
  const stem = candidate.split('.')[0]?.toUpperCase() ?? '';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    return `_${candidate}`;
  }
  if (candidate === '.' || candidate === '..') return 'download.bin';
  return candidate;
}

function normalizedTotal(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
