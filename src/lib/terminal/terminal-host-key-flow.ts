export interface CompleteHostKeyTrustBeforeConnectOptions {
  trustHostKey: () => Promise<void>;
  clearHostKeyPrompt: () => void | Promise<void>;
  connect: () => Promise<string>;
}

export async function completeHostKeyTrustBeforeConnect(
  options: CompleteHostKeyTrustBeforeConnectOptions
): Promise<string> {
  await options.trustHostKey();
  await options.clearHostKeyPrompt();
  return options.connect();
}
