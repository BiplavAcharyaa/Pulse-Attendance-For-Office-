import type { ApiResult } from '../shared/types';

export interface PulseBridge {
  call(method: string, token: string | undefined, args?: unknown): Promise<ApiResult<any>>;
  env(): Promise<{ platform: string; version: string; mode: 'admin' | 'terminal'; exportsDir: string; liveUrl: string }>;
  terminalKey(): Promise<string | null>;
}

declare global {
  interface Window {
    pulse: PulseBridge;
    __pulseReady?: boolean;
  }
}
