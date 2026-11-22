export const CORRECTIONS_PATH: string;
export function parseClock(s: string): number | null;
export function weeksToBits(weeks: unknown): number | null;
export function loadCorrections(source?: string | object): CorrectionsFile;
export function invalidCorrections(data: unknown): string[];
export function applyCorrections<T extends { cnn: string | number; side: string; street?: string; limits?: string; blockside?: string; r: unknown }>(
  sides: T[],
  data: CorrectionsFile,
): T[];

export interface CorrectionRule {
  day: string;
  weeks: number[];
  from: string;
  to: string;
  holidays?: boolean;
}
export interface CorrectionEntry {
  cnn: string;
  side: "L" | "R";
  street?: string;
  limits?: string;
  blockside?: string;
  rules: CorrectionRule[];
  source: string;
  reported: string;
  note?: string;
}
export interface CorrectionsFile {
  version: 1;
  corrections: CorrectionEntry[];
}
