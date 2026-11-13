export interface Replay {
  url(variant?: string): string;
  requests(): number;
  methods(): string[];
  close(): Promise<void>;
}
export const MUTATIONS: Record<string, (req: any, result: any) => any>;
export function loadRecording(network?: string): any;
export function requestKey(req: any): string;
export function startReplay(options?: { port?: number; recording?: unknown }): Promise<Replay>;
