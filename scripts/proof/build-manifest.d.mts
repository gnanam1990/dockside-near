export const ROOT: string;
export const SOURCES: string;
export const MANIFEST: string;
export function buildManifest(sources: any, read?: (path: string) => any): any;
export function render(manifest: unknown): string;
