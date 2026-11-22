export const REQUIRED_FILES: string[];
export const JSON_DATA_FILES: string[];
export function missingData(dist?: string): string[];
export function invalidJsonData(dist?: string): string[];
export function invalidCorrectionsFile(path?: string): string[];
export function invalidCorrectedIndex(index: unknown, corrections?: unknown): string[];
