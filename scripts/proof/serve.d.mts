export const SITE: string;
export function startSite(options?: {
  port?: number;
  root?: string;
}): Promise<{ url: string; close(): Promise<void> }>;
