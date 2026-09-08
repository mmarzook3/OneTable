export type NfcReadingEvent = {
  message?: { records?: Array<{ recordType?: string; encoding?: string; data?: DataView }> };
};
export type NfcReader = {
  write(message: { records: Array<{ recordType: 'url'; data: string }> }): Promise<void>;
  scan(): Promise<void>;
  abort?(): void;
  onreading: ((event: NfcReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
};
export type NfcReaderConstructor = new () => NfcReader;
type NativeBridge = {
  scan(requestId: string): void;
  write(requestId: string, url: string): void;
  cancel(requestId: string): void;
};

function allowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['scanaki.uk', 'www.scanaki.uk'].includes(url.hostname)
      && !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
}

/** Prefer the app's hardware bridge; ordinary browsers retain Web NFC. */
export function getNfcReader(): NfcReaderConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const host = window as unknown as { ScanakiNfc?: NativeBridge; NDEFReader?: NfcReaderConstructor };
  const bridge = host.ScanakiNfc;
  if (!bridge) return host.NDEFReader;
  return class implements NfcReader {
    onreading: ((event: NfcReadingEvent) => void) | null = null;
    onreadingerror: (() => void) | null = null;
    private cancelPending?: () => void;

    abort(): void { this.cancelPending?.(); }

    private request(mode: 'scan' | 'write', url = ''): Promise<string> {
      this.abort();
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const finish = (error?: Error, result = '') => {
          window.clearTimeout(timer);
          window.removeEventListener('scanaki:nfc-result', receive);
          this.cancelPending = undefined;
          if (error) reject(error); else resolve(result);
        };
        const receive = (event: Event) => {
          const detail = (event as CustomEvent).detail;
          if (!detail || detail.requestId !== id) return;
          if (detail.status !== 'success') {
            finish(new Error('NFC operation unavailable or cancelled'));
          } else if (mode === 'scan' && (typeof detail.url !== 'string' || !allowedUrl(detail.url))) {
            finish(new Error('Unsupported NFC URL'));
          } else finish(undefined, detail.url || '');
        };
        this.cancelPending = () => {
          try { bridge.cancel(id); } finally { finish(new Error('NFC operation cancelled')); }
        };
        const timer = window.setTimeout(() => this.abort(), 90000);
        window.addEventListener('scanaki:nfc-result', receive);
        try {
          if (mode === 'scan') bridge.scan(id); else bridge.write(id, url);
        } catch { finish(new Error('Native NFC request failed')); }
      });
    }

    async scan(): Promise<void> {
      try {
        const url = await this.request('scan');
        const bytes = new TextEncoder().encode(url);
        this.onreading?.({ message: { records: [{ recordType: 'url', encoding: 'utf-8', data: new DataView(bytes.buffer) }] } });
      } catch (error) { this.onreadingerror?.(); throw error; }
    }

    async write(message: { records: Array<{ recordType: 'url'; data: string }> }): Promise<void> {
      if (message.records.length !== 1 || !allowedUrl(message.records[0].data)) {
        throw new Error('Only a Scanaki HTTPS URL can be written');
      }
      await this.request('write', message.records[0].data);
    }
  };
}
