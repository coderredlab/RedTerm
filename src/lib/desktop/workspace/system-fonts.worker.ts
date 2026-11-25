import { isUsableMonospace } from "./font-metrics";

self.onmessage = ({ data }: MessageEvent<string[]>) => {
  const context = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(1, 1).getContext("2d")
    : null;
  self.postMessage(context ? data.filter((family) => isUsableMonospace(context, family)) : null);
};
