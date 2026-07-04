// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type RemoteStreamEvent = {
  event?: string;
  ok?: boolean;
  name?: string;
  data?: Record<string, unknown>;
  error?: string;
  stats?: Record<string, unknown>;
  [key: string]: unknown;
};

export type RemoteStreamClientHandlers = {
  onEvent?: (event: RemoteStreamEvent) => void | Promise<void>;
  onChunkText?: (content: string, event: RemoteStreamEvent) => void | Promise<void>;
  onError?: (error: Error, event?: RemoteStreamEvent) => void | Promise<void>;
};

export type RemoteStreamClientOptions = {
  signal?: AbortSignal;
  maxBufferedLineBytes?: number;
};

export class RemoteStreamClient {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private readonly maxBufferedLineBytes: number;

  constructor(private readonly response: Response, private readonly handlers: RemoteStreamClientHandlers = {}, options: RemoteStreamClientOptions = {}) {
    this.maxBufferedLineBytes = options.maxBufferedLineBytes && options.maxBufferedLineBytes > 0 ? options.maxBufferedLineBytes : 1 << 20;
    if (options.signal) {
      options.signal.throwIfAborted();
    }
  }

  async readNDJSON(signal?: AbortSignal): Promise<void> {
    if (!this.response.ok) {
      throw new Error(await this.response.text().catch(() => `Remote stream failed with HTTP ${this.response.status}.`));
    }
    let pending = '';
    const consumeLine = async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: RemoteStreamEvent;
      try {
        event = JSON.parse(trimmed) as RemoteStreamEvent;
      } catch (error) {
        throw new Error(`Remote stream returned an invalid event frame: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (event.event === 'error' || event.ok === false) {
        const failure = new Error(textValue(event.error) || 'Remote stream returned an error event.');
        await this.handlers.onError?.(failure, event);
        throw failure;
      }
      await this.handlers.onEvent?.(event);
      if (event.event === 'chunk') {
        await this.handlers.onChunkText?.(textValue(event.content), event);
      }
    };

    if (this.response.body) {
      const reader = this.response.body.getReader();
      for (;;) {
        signal?.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        pending += this.decoder.decode(part.value, { stream: true });
        if (pending.length > this.maxBufferedLineBytes) {
          throw new Error('Remote stream event line exceeded the browser safety limit.');
        }
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          await consumeLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      }
      pending += this.decoder.decode();
    } else {
      pending = await this.response.text();
    }

    if (pending.trim()) {
      await consumeLine(pending);
    }
  }
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
