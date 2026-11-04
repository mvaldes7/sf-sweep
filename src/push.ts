import { config } from "./config";

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Must be called from a user gesture (iOS requirement). Stores only subscription + spot + fire time. */
export async function enablePush(spot: { cnn: string; side: string; lat: number; lng: number }, fireAt: number) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("notifications not allowed");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(config.vapidPublicKey) as BufferSource }));
  const res = await fetch(`${config.apiBase}/api/spot`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), spot, fireAt }),
  });
  if (!res.ok) throw new Error(`server ${res.status}`);
}

export async function disablePush() {
  if (!pushSupported() || !config.apiBase) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch(`${config.apiBase}/api/spot`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
}
