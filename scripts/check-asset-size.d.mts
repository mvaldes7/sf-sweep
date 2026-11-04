export const PAGES_MAX_FILE_BYTES: number;
export function oversized(dir: string, max?: number): Promise<{ path: string; size: number }[]>;
export function makeTempFiles(files: Record<string, number>): string;
export function readJsonIfExists(file: string): unknown;
