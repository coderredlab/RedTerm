import { listSystemFonts } from "$lib/tauri/commands";

export async function loadSystemFonts(signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) throw signal.reason;
  // WKWebView can hide user-installed fonts from OffscreenCanvas while the
  // terminal's connected canvas can render them (WebKit bug 316777).
  if (navigator.platform.startsWith("Mac") || navigator.userAgent.includes("Macintosh")) {
    return listSystemFonts(true);
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./system-fonts.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return listSystemFonts(true);
  }

  let onAbort: (() => void) | undefined;
  try {
    const result = await new Promise<string[] | null>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      worker.onerror = worker.onmessageerror = () => resolve(null);
      worker.onmessage = ({ data }: MessageEvent<"ready" | string[] | null>) => {
        if (data !== "ready") { resolve(data); return; }
        // Ask for the catalog only after we know this WebView has worker 2D.
        listSystemFonts().then((families) => {
          if (!signal.aborted) worker.postMessage(families);
        }).catch(reject);
      };
    });
    if (result !== null) return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    worker.terminate();
  }

  // Worker 2D isn't available in every desktop WebView. Keep a full scan off
  // the window thread there too: the native command checks installed faces.
  if (signal.aborted) throw signal.reason;
  return listSystemFonts(true);
}
