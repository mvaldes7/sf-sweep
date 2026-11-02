/** Parked car, stored only on this device (localStorage). */
export interface Car {
  id: number; cnn: string; side: "L" | "R"; lng: number; lat: number; savedAt: number;
  alert?: boolean; alertError?: string;
}
const KEY = "sfsweep.car.v1";
export function loadCar(): Car | null {
  try { const v = localStorage.getItem(KEY); return v ? (JSON.parse(v) as Car) : null; } catch { return null; }
}
export function saveCar(c: Car) { localStorage.setItem(KEY, JSON.stringify(c)); }
export function clearCar() { localStorage.removeItem(KEY); }
