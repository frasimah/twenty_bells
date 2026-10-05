type SyncResult = { success: boolean; error?: { message?: string } };

// Twenty checks every uploaded file against its extension with one shared
// `file-type` parser, and that parser keeps its working state on the instance.
// Files that arrive together — and a sync sends all of them at once — overwrite
// each other's state, so a perfectly good PNG can come back as "not a PNG". It
// surfaces on the first sync after the server starts; the next attempt runs on a
// warm server and passes. Nothing in the app can prevent it, so the harness
// asks again instead of reporting a failure that is not the app's.
export const isUploadRace = (result: SyncResult) =>
  !result.success &&
  /File content does not match its extension/.test(result.error?.message ?? '');

type RetryOptions<TResult> = {
  attempts: number;
  delayMs: number;
  isTransient: (result: TResult) => boolean;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Runs `run` again while its result is transient, `attempts` runs at most. The
// last result comes back either way, so the caller still decides in one place
// what a failure means — only the failures that say they may pass are repeated.
export async function retryOnTransient<TResult>(
  run: () => Promise<TResult>,
  { attempts, delayMs, isTransient }: RetryOptions<TResult>,
): Promise<TResult> {
  let result = await run();

  for (let attempt = 1; attempt < attempts && isTransient(result); attempt++) {
    await sleep(delayMs);
    result = await run();
  }

  return result;
}
