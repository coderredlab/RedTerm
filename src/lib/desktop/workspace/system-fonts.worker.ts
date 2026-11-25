import { isUsableMonospace } from "./font-metrics";

const context = typeof OffscreenCanvas !== "undefined"
  ? new OffscreenCanvas(1, 1).getContext("2d")
  : null;

if (context) {
  self.onmessage = ({ data }: MessageEvent<string[]>) => {
    self.postMessage(data.filter((family) => isUsableMonospace(context, family)));
  };
}
self.postMessage(context ? "ready" : null);
