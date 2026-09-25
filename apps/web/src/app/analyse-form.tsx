'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { toView, type OutcomeView } from '@/lib/outcome-view';
import {
  analyse,
  AnalysisError,
  hashFile,
  quickReject,
  type AnalysisResult,
  type Stage,
} from '@/lib/analyse';

/** Plain words, no fake percentages - the real progress of an upload is
 *  not something the browser can honestly report mid-PUT. */
const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  idle: '',
  hashing: 'Reading photo',
  uploading: 'Uploading photo',
  analysing: 'Analysing photo',
  scoring: 'Scoring photo',
  done: 'Complete',
  failed: '',
};

interface Failure {
  readonly message: string;
  readonly canResume: boolean;
  readonly photoId: string | null;
  readonly retryAfterSeconds: number | null;
}

export function AnalyseForm({
  supabaseUrl,
  supabaseAnonKey,
}: {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [view, setView] = useState<OutcomeView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // A ref, not state: the guard must be correct on the same tick a
  // second click arrives, and a state update is not.
  const running = useRef(false);
  /**
   * React state does not own a file input's value - the DOM does.
   * Clearing `file` alone left the native input still holding its
   * FileList, so the old filename stayed on screen after a reset and,
   * worse, re-picking the SAME photo fired no `change` event at all
   * (the value had not changed), leaving the user stuck on a form that
   * looked ready and did nothing.
   */
  const fileInput = useRef<HTMLInputElement>(null);

  // Object URLs are a leak if they are never revoked, and a stale
  // preview is worse than none.
  useEffect(() => {
    if (file === null) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const busy = stage === 'hashing' || stage === 'uploading' || stage === 'analysing' || stage === 'scoring';

  const run = useCallback(
    async (resumePhotoId: string | null) => {
      if (file === null || running.current) return;
      running.current = true;
      setFailure(null);
      setView(null);
      try {
        const result: AnalysisResult = await analyse(
          { file, resumePhotoId },
          {
            fetch: globalThis.fetch.bind(globalThis),
            sha256: hashFile,
            supabaseUrl,
            supabaseAnonKey,
            onStage: setStage,
          },
        );
        setView(toView(result.outcome));
        setStage('done');
      } catch (error) {
        setStage('failed');
        // An unexpected throw shows the user a safe message and tells
        // the developer nothing unless it is logged. The user-facing
        // string stays generic; the console gets the real cause.
        if (!(error instanceof AnalysisError)) console.error('[analyse]', error);
        setFailure(
          error instanceof AnalysisError
            ? {
                message: error.message,
                canResume: error.canResume,
                photoId: error.photoId,
                retryAfterSeconds: error.retryAfterSeconds,
              }
            : {
                message: 'Something went wrong. Try again in a moment.',
                canResume: false,
                photoId: null,
                retryAfterSeconds: null,
              },
        );
      } finally {
        running.current = false;
      }
    },
    [file, supabaseUrl, supabaseAnonKey],
  );

  const onSelect = (next: File | null): void => {
    setFile(next);
    setStage('idle');
    setView(null);
    setFailure(next === null ? null : { message: quickReject(next) ?? '', canResume: false, photoId: null, retryAfterSeconds: null });
    if (next !== null && quickReject(next) === null) setFailure(null);
  };

  const reset = (): void => {
    setFile(null);
    setStage('idle');
    setView(null);
    setFailure(null);
    // Purely local: clearing the input fires no `change` and touches no
    // network. The object URL is revoked by the effect above when
    // `file` becomes null.
    if (fileInput.current !== null) fileInput.current.value = '';
  };

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="photo">
          Your photo
        </label>
        <input
          id="photo"
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(event) => onSelect(event.target.files?.[0] ?? null)}
          className="rounded-lg border border-black/10 px-4 py-3 text-sm"
        />
        <p className="text-muted text-sm">
          JPEG, PNG or WebP, under 10MB. The photo is uploaded exactly as you selected it.
        </p>
      </div>

      {preview !== null && (
        // A local object URL, never a remote asset, so next/image would
        // add a loader and an optimisation pass for no benefit.
        <img src={preview} alt="The photo you selected" className="max-h-80 w-auto rounded-lg border border-black/10" />
      )}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={file === null || busy}
          onClick={() => void run(null)}
          className="rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? STAGE_LABEL[stage] : 'Score this photo'}
        </button>
        {(view !== null || failure !== null) && !busy && (
          <button type="button" onClick={reset} className="rounded-lg border border-black/10 px-5 py-2.5 text-sm">
            Try another photo
          </button>
        )}
      </div>

      {busy && (
        <p aria-live="polite" className="text-muted text-sm">
          {STAGE_LABEL[stage]}&hellip;
        </p>
      )}

      {failure !== null && failure.message !== '' && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
          <p className="text-sm">{failure.message}</p>
          {failure.retryAfterSeconds !== null && (
            <p className="text-muted text-sm">Try again in about {failure.retryAfterSeconds} seconds.</p>
          )}
          {failure.canResume && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(failure.photoId)}
              className="self-start rounded-lg border border-black/10 px-4 py-2 text-sm"
            >
              Retry without re-uploading
            </button>
          )}
        </div>
      )}

      {view !== null && <Result view={view} />}
    </section>
  );
}

function Result({ view }: { readonly view: OutcomeView }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-black/10 px-5 py-4">
      <div>
        <p className="text-3xl font-semibold tracking-tight">{view.headline}</p>
        <p className="text-muted text-sm">{view.detail}</p>
      </div>

      {view.rows.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {view.rows.map((row) => (
            <li key={row.axis} className="flex items-baseline justify-between gap-4 text-sm">
              <span className="font-medium">{row.axis}</span>
              <span className="text-muted flex-1 text-xs">{row.description}</span>
              <span className="tabular-nums">{row.score}/5</span>
            </li>
          ))}
        </ul>
      )}

      {view.fixes.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium uppercase tracking-wide">What to change</h3>
          <ul className="flex flex-col gap-1.5">
            {view.fixes.map((fix) => (
              <li key={fix.axis} className="text-sm">
                {fix.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.caveat !== null && <p className="text-muted text-sm">{view.caveat}</p>}
    </div>
  );
}
