/**
 * @vitest-environment jsdom
 *
 * Regression cover for the reset defect found in the Step 21 production
 * smoke test.
 *
 * React state and a file input disagree about who owns the value: the
 * DOM does. `reset()` cleared `file`, so the app behaved correctly and
 * fired no requests - but the native input kept its FileList, which left
 * the old filename on screen and, worse, meant picking the SAME photo
 * again fired no `change` event at all. The form looked ready and did
 * nothing.
 *
 * "Try another photo" only renders once there is a result or a failure,
 * so these tests reach it through a controlled failed analysis of an
 * otherwise valid selected photo. That is the same `reset` the scored path calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnalysisError } from '@/lib/analyse';

const mockAnalyse = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analyse', async (importOriginal) => ({
  ...await importOriginal(),
  analyse: mockAnalyse,
}));

import { AnalyseForm } from './analyse-form.js';

beforeEach(() => {
  mockAnalyse.mockReset();
  mockAnalyse.mockRejectedValue(new AnalysisError('authorize', 'Could not start the upload.'));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** jsdom has no object-URL implementation; record the calls instead. */
function stubObjectUrls(): { created: string[]; revoked: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => {
      const url = `blob:test/${(n += 1)}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => void revoked.push(url),
  });
  return { created, revoked };
}

function renderForm(): HTMLInputElement {
  render(<AnalyseForm supabaseUrl="https://example.supabase.co" supabaseAnonKey="anon-key" />);
  return document.querySelector('input[type=file]') as HTMLInputElement;
}

function selectedPhoto(name = 'portrait.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: 'image/jpeg' });
}

function select(input: HTMLInputElement, file: File): void {
  fireEvent.change(input, { target: { files: [file] } });
}

function reset(): void {
  fireEvent.click(screen.getByRole('button', { name: /try another photo/i }));
}

async function reachFailure(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /analyze my photo/i }));
  await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
}

/**
 * Records writes to the input's `value`.
 *
 * `fireEvent.change(input, {target:{files}})` installs its own `files`
 * property on the element, and that stub outlives `value = ''` - so
 * asserting on `input.files` after a reset would fail in jsdom for a
 * reason that has nothing to do with the product. Clearing `value` IS
 * the mechanism that empties a real FileList, so watch for that write
 * directly rather than for a side effect jsdom does not model.
 */
function watchValueWrites(input: HTMLInputElement): string[] {
  const writes: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as object,
    'value',
  );
  if (descriptor?.get === undefined || descriptor.set === undefined) {
    throw new Error('HTMLInputElement.value is not an accessor in this environment');
  }
  const { get, set } = descriptor;
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => get.call(input) as string,
    set: (next: string) => {
      writes.push(next);
      set.call(input, next);
    },
  });
  return writes;
}

describe('AnalyseForm reset', () => {
  it('clears the native file input, not just React state', async () => {
    stubObjectUrls();
    const input = renderForm();
    const valueWrites = watchValueWrites(input);

    select(input, selectedPhoto());
    expect(valueWrites).toEqual([]);

    await reachFailure();
    reset();

    // The assertion the production defect would have failed: reset must
    // reach through to the DOM, which React state alone never does.
    expect(valueWrites).toEqual(['']);
    expect(input.value).toBe('');
  });

  it('clears the preview and revokes its object URL', async () => {
    const urls = stubObjectUrls();
    const input = renderForm();

    select(input, selectedPhoto());
    expect(document.querySelector('img')).not.toBeNull();
    expect(urls.created).toHaveLength(1);

    await reachFailure();
    reset();

    expect(document.querySelector('img')).toBeNull();
    expect(urls.revoked).toEqual(urls.created);
  });

  it('clears the failure message', async () => {
    stubObjectUrls();
    const input = renderForm();

    select(input, selectedPhoto());
    await reachFailure();
    expect(screen.queryByRole('button', { name: /try another photo/i })).not.toBeNull();

    reset();

    // The reset control itself disappears once the failure is cleared.
    expect(screen.queryByRole('button', { name: /try another photo/i })).toBeNull();
  });

  it('accepts the same file again after a reset', async () => {
    stubObjectUrls();
    const input = renderForm();
    const same = selectedPhoto('same.jpg');

    select(input, same);
    await reachFailure();
    reset();
    select(input, same);

    // jsdom cannot model the browser's "no change event when the value
    // is unchanged" rule - fireEvent dispatches unconditionally - so
    // this proves the component re-accepts the file, and the preceding
    // test proves the value is cleared, which is what makes a real
    // browser fire that second event. End-to-end reselection was
    // confirmed against production.
    expect(input.files?.[0]?.name).toBe('same.jpg');
    expect(document.querySelector('img')).not.toBeNull();
  });

  it('makes no network request merely from resetting', async () => {
    stubObjectUrls();
    const fetchSpy = vi.fn(() => Promise.reject(new Error('reset must not call fetch')));
    vi.stubGlobal('fetch', fetchSpy);
    const input = renderForm();

    select(input, selectedPhoto());
    await reachFailure();
    reset();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockAnalyse).toHaveBeenCalledTimes(1);
  });
});
