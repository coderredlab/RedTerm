import { isUsableMonospace } from "./font-metrics";

export async function filterSystemFonts(families: string[], signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  let worker: Worker | undefined;
  let onAbort: (() => void) | undefined;
  try {
    worker = new Worker(new URL("./system-fonts.worker.ts", import.meta.url), { type: "module" });
    const active = worker;
    const result = await new Promise<string[] | null>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      active.onmessage = (event: MessageEvent<string[] | null>) => resolve(event.data);
      active.onerror = () => resolve(null);
      active.postMessage(families);
    });
    if (result !== null) return result;
  } catch {
    signal.throwIfAborted();
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    worker?.terminate();
  }

  // Older WebViews may not support a worker 2D context. Give input and paint
  // a turn between small slices instead of scanning the catalog in one task.
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Font measurements unavailable");
  const matches: string[] = [];
  for (let i = 0; i < families.length;) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
    const until = performance.now() + 4;
    do {
      const family = families[i++];
      if (isUsableMonospace(context, family)) matches.push(family);
    } while (i < families.length && performance.now() < until);
  }
  return matches;
}
