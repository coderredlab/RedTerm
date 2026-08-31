export interface BrowserClipboardWriter {
  writeText(text: string): Promise<void>;
}

export async function writeTerminalClipboardText(
  text: string,
  isDesktopTarget: boolean,
  writeDesktopText: (text: string) => Promise<void>,
  browserClipboard: BrowserClipboardWriter | undefined,
): Promise<void> {
  if (isDesktopTarget) {
    await writeDesktopText(text);
    return;
  }
  if (!browserClipboard) {
    throw new Error("Clipboard writing is unavailable");
  }
  await browserClipboard.writeText(text);
}

export async function resolveTerminalClipboardImagePath(
  localPath: string,
  isLocalSession: boolean,
  uploadToRemote?: (localPath: string) => Promise<string>,
): Promise<string> {
  if (isLocalSession) return localPath;
  if (!uploadToRemote) throw new Error("Remote image uploader is unavailable");
  return uploadToRemote(localPath);
}
