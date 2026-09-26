'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { toView, type OutcomeView } from '@/lib/outcome-view';
import {
  analyse,
  AnalysisError,
  hashFile,
  quickReject,
  type AnalysisResult,
  type FailureStage,
  type Stage,
} from '@/lib/analyse';

import { AnalysisProgress } from './analysis-progress';
import { ResultPanel } from './result-panel';

interface Failure {
  readonly message: string;
  readonly stage: FailureStage | 'unexpected';
  readonly code: string | null;
  readonly canResume: boolean;
  readonly photoId: string | null;
  readonly retryAfterSeconds: number | null;
}

const NEXT_STEP: Readonly<Record<Failure['stage'], string>> = {
  validate: 'Choose a JPEG, PNG, or WebP photo under 10 MB.',
  authorize: 'Wait a moment, then try again with this photo.',
  upload: 'Check your connection, then try the upload again.',
  extract: 'Your photo is uploaded. You can retry the review.',
  score: 'Your photo is ready. You can retry the result.',
  unexpected: 'Please try again. If this keeps happening, choose another photo.',
};

const IMAGE_ERROR_HELP: Readonly<Record<string, string>> = {
  not_an_image: 'Choose a JPEG, PNG, or WebP photo.',
  mime_mismatch: 'Re-export this image as a JPEG, PNG, or WebP file, then choose the new file.',
  corrupt_file: 'Choose another photo if re-exporting does not work.',
  below_dimension_floor: 'Choose a larger photo that is at least 200 pixels on its shorter side.',
  hash_mismatch: 'Choose the photo again so it can be uploaded afresh.',
};

function PhotoStage({ preview, file, caption }: {
  readonly preview: string | null;
  readonly file: File;
  readonly caption: string;
}) {
  return (
    <div className="photo-stage">
      <div className="photo-stage__image">
        {preview === null ? <p>Preparing preview...</p> : <img src={preview} alt="The photo you selected" />}
      </div>
      <div className="photo-stage__caption"><span>{caption}</span><span title={file.name}>{file.name}</span></div>
    </div>
  );
}

export function AnalyseForm({ supabaseUrl, supabaseAnonKey }: {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [view, setView] = useState<OutcomeView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // Ref protection is immediate, even when React has not rendered a new
  // disabled state after the first click.
  const running = useRef(false);
  // The browser owns the native FileList. Clearing React state alone does
  // not allow the same file to be selected again after a reset.
  const fileInput = useRef<HTMLInputElement>(null);

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

  const run = useCallback(async (resumePhotoId: string | null) => {
    if (file === null || running.current) return;
    running.current = true;
    setFailure(null);
    setView(null);
    try {
      const result: AnalysisResult = await analyse({ file, resumePhotoId }, {
        fetch: globalThis.fetch.bind(globalThis),
        sha256: hashFile,
        supabaseUrl,
        supabaseAnonKey,
        onStage: setStage,
      });
      setView(toView(result.outcome));
      setStage('done');
    } catch (error) {
      setStage('failed');
      if (!(error instanceof AnalysisError)) console.error('[analyse]', error);
      setFailure(error instanceof AnalysisError
        ? { message: error.message, stage: error.stage, code: error.code, canResume: error.canResume,
          photoId: error.photoId, retryAfterSeconds: error.retryAfterSeconds }
        : { message: 'Something went wrong. Try again in a moment.', stage: 'unexpected', code: null,
          canResume: false, photoId: null, retryAfterSeconds: null });
    } finally {
      running.current = false;
    }
  }, [file, supabaseUrl, supabaseAnonKey]);

  const onSelect = (next: File | null): void => {
    if (next === null) return;
    const rejection = quickReject(next);
    setStage(rejection === null ? 'idle' : 'failed');
    setView(null);
    if (rejection !== null) {
      setFile(null);
      setFailure({ message: rejection, stage: 'validate', code: null, canResume: false,
        photoId: null, retryAfterSeconds: null });
      if (fileInput.current !== null) fileInput.current.value = '';
      return;
    }
    setFile(next);
    setFailure(null);
  };

  const reset = (): void => {
    setFile(null);
    setStage('idle');
    setView(null);
    setFailure(null);
    setDragging(false);
    dragDepth.current = 0;
    if (fileInput.current !== null) fileInput.current.value = '';
    // The preview effect revokes its object URL when `file` becomes null.
  };

  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    if (busy) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    // A dropped file does not update the native input's FileList. Clear
    // an older picker selection so that the same file can be chosen next.
    if (fileInput.current !== null) fileInput.current.value = '';
    onSelect(event.dataTransfer.files[0] ?? null);
  };

  return (
    <section className="experience" data-state={view !== null ? 'result' : busy ? 'analysing' : 'upload'}>
      <input id="photo" ref={fileInput} type="file" className="photo-input" aria-label="Choose a photo"
        accept="image/jpeg,image/png,image/webp" disabled={busy || view !== null}
        onChange={(event) => onSelect(event.target.files?.[0] ?? null)} />

      {view !== null && file !== null ? (
        <div className="experience-layout experience-layout--result">
          <div className="experience-layout__photo"><PhotoStage preview={preview} file={file} caption="Photo reviewed" /></div>
          <ResultPanel view={view} onReset={reset} />
        </div>
      ) : busy && file !== null ? (
        <div className="experience-layout experience-layout--analysis">
          <div className="experience-layout__photo"><PhotoStage preview={preview} file={file} caption="Your selected photo" /></div>
          <AnalysisProgress stage={stage} />
        </div>
      ) : (
        <div className="experience-layout experience-layout--upload">
          <div className="upload-intro">
            <p className="section-kicker">Profile photo review</p>
            <h1>A clearer look at your profile photo.</h1>
            <p className="upload-intro__lead">Get a photo score and practical ideas for your next shot. We review the photograph, not the person in it.</p>
          </div>

          <div className="upload-workspace">
            {file === null ? (
              <label htmlFor="photo" className={`upload-drop ${dragging ? 'is-dragging' : ''}`}
                onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                <span className="upload-drop__symbol" aria-hidden="true"><span /></span>
                <strong>Drop your photo here</strong>
                <span>or choose one from your device</span>
                <span className="button button--primary upload-drop__button">Choose a photo</span>
                <small>JPEG, PNG or WebP · Up to 10 MB</small>
              </label>
            ) : (
              <div className="selected-photo" onDragEnter={onDragEnter} onDragLeave={onDragLeave}
                onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                <PhotoStage preview={preview} file={file} caption="Ready to review" />
                <div className="selected-photo__actions">
                  <p>Your photo is ready. We will review its visual quality and presentation.</p>
                  <label htmlFor="photo" className="text-action">Change photo</label>
                </div>
                {dragging && <p className="selected-photo__drop-hint">Drop to replace this photo</p>}
              </div>
            )}

            {failure !== null && (
              <div className="error-panel" role="alert">
                <div><strong>We could not finish this review.</strong><p>{failure.message}</p>
                  <p>{failure.code === null ? NEXT_STEP[failure.stage] : IMAGE_ERROR_HELP[failure.code] ?? NEXT_STEP[failure.stage]}</p>
                  {failure.retryAfterSeconds !== null && <p>Try again in about {failure.retryAfterSeconds} seconds.</p>}
                </div>
                <div className="error-panel__actions">
                  {file !== null && (failure.code === null || !Object.hasOwn(IMAGE_ERROR_HELP, failure.code)) && <button type="button" className="button button--primary"
                    onClick={() => void run(failure.canResume ? failure.photoId : null)}>Try again</button>}
                  <button type="button" className="text-action" onClick={reset}>Try another photo</button>
                </div>
              </div>
            )}

            {file !== null && failure === null && (
              <button type="button" className="button button--primary analyse-action"
                onClick={() => void run(null)}>Analyze my photo</button>
            )}
            <p className="privacy-note">Your photo is used for this review. Uploaded photos are scheduled for deletion after 30 days.</p>
          </div>
          <div className="overview">
            <p>What we look at</p>
            <div><strong>Image quality</strong><span>Sharpness, lighting, resolution, framing</span></div>
            <div><strong>Presentation</strong><span>Background, attire, expression, one clear subject</span></div>
          </div>
        </div>
      )}
    </section>
  );
}
