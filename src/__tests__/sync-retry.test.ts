import { describe, expect, it, vi } from 'vitest';

import { isUploadRace, retryOnTransient } from 'src/__tests__/sync-retry';

// The message exactly as Twenty returned it to this repo's CI, which is the
// string the harness has to recognise.
const UPLOAD_RACE_MESSAGE =
  "Failed to upload .twenty/output/public/gallery-1-feed.png: File content does not match its extension. The file has extension 'png' (expected mime type: image/png), but the file content could not be detected as this type. The file may be corrupted, have the wrong extension, or be a security risk.";

describe('isUploadRace', () => {
  it('should recognise the upload failure Twenty reports for a valid file', () => {
    expect(
      isUploadRace({ success: false, error: { message: UPLOAD_RACE_MESSAGE } }),
    ).toBe(true);
  });

  it('should not treat any other failure as transient', () => {
    expect(
      isUploadRace({
        success: false,
        error: {
          message:
            '"95427093-8188-4051-8f40-a94930b08548" is registered on this instance but claimed by no workspace. Claim its ownership before developing on it.',
        },
      }),
    ).toBe(false);
    expect(isUploadRace({ success: false })).toBe(false);
  });

  it('should not treat a success as transient', () => {
    expect(isUploadRace({ success: true })).toBe(false);
  });
});

describe('retryOnTransient', () => {
  const options = { attempts: 3, delayMs: 0, isTransient: isUploadRace };
  const raced = { success: false, error: { message: UPLOAD_RACE_MESSAGE } };

  it('should run once when the first result is not transient', async () => {
    const run = vi.fn().mockResolvedValue({ success: true });

    await expect(retryOnTransient(run, options)).resolves.toEqual({
      success: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('should run again after a transient failure and return the result that passes', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(raced)
      .mockResolvedValueOnce({ success: true });

    await expect(retryOnTransient(run, options)).resolves.toEqual({
      success: true,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('should return the last transient failure once the attempts run out', async () => {
    const run = vi.fn().mockResolvedValue(raced);

    await expect(retryOnTransient(run, options)).resolves.toEqual(raced);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('should not repeat a failure that is not transient', async () => {
    const failure = { success: false, error: { message: 'Typecheck failed' } };
    const run = vi.fn().mockResolvedValue(failure);

    await expect(retryOnTransient(run, options)).resolves.toEqual(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
