/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnalysisOutcome } from '@pps/schema';
import { AnalysisError } from '@/lib/analyse';

const mockAnalyse = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analyse', async (importOriginal) => ({
  ...await importOriginal(),
  analyse: mockAnalyse,
}));

import { AnalyseForm } from './analyse-form';

const full: AnalysisOutcome = {
  status: 'scored',
  result: {
    score: 6.8,
    axes: { sharpness: 4, lighting: 3, resolution: 5, framing: 2,
      background: 4, attire: 3, expression: 4, solo: 5 },
    context: 'corporate',
    fixes: [{ axis: 'framing', severity: 'high', message: 'Move closer to the camera.' }],
    confidence: 0.95,
    weightsVersion: '2026-09-24.1',
    coverage: 'full',
  },
};

const noFace: AnalysisOutcome = {
  status: 'declined',
  reason: 'no_face',
  message: 'No face was found in the photo.',
  score: {
    score: 2,
    axes: { sharpness: 5, lighting: 5, resolution: 4, framing: 1 },
    context: 'corporate',
    fixes: [],
    confidence: 0.55,
    weightsVersion: '2026-09-24.1',
    coverage: 'partial',
  },
};

function result(outcome: AnalysisOutcome): { outcome: AnalysisOutcome } {
  // The component only reads the outcome; transport fields are tested in analyse.test.ts.
  return { outcome };
}

function photo(name = 'portrait.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: 'image/jpeg' });
}

function select(file: File): void {
  fireEvent.change(screen.getByLabelText('Choose a photo'), { target: { files: [file] } });
}

function renderForm(): void {
  render(<AnalyseForm supabaseUrl="https://example.supabase.co" supabaseAnonKey="anon-key" />);
}

beforeEach(() => {
  mockAnalyse.mockReset();
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AnalyseForm product journey', () => {
  it('starts with an accessible upload and accepts a dropped photo', () => {
    renderForm();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('profile photo');
    expect(screen.getByLabelText('Choose a photo')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Analyze my photo' })).toBeNull();

    const dropzone = screen.getByText('Drop your photo here').closest('label');
    if (dropzone === null) throw new Error('Upload dropzone was not rendered');
    fireEvent.drop(dropzone, { dataTransfer: { files: [photo()] } });
    expect(screen.getByAltText('The photo you selected')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Analyze my photo' })).not.toBeNull();
  });

  it('keeps the photo visible through progress and renders all eight scored axes', async () => {
    let finish!: (value: { outcome: AnalysisOutcome }) => void;
    mockAnalyse.mockImplementation((_input, deps: { onStage: (stage: string) => void }) => {
      deps.onStage('analysing');
      return new Promise<{ outcome: AnalysisOutcome }>((resolve) => { finish = resolve; });
    });
    renderForm();
    select(photo());
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my photo' }));

    expect(screen.getByRole('status').textContent).toContain('Reviewing the photograph');
    expect(screen.getByAltText('The photo you selected')).not.toBeNull();
    expect((screen.getByLabelText('Choose a photo') as HTMLInputElement).disabled).toBe(true);
    expect(mockAnalyse).toHaveBeenCalledTimes(1);

    finish(result(full));
    await waitFor(() => expect(screen.getByText('6.8')).not.toBeNull());
    expect(document.querySelectorAll('.score-row')).toHaveLength(8);
    expect(screen.getByText('Move closer to the camera.')).not.toBeNull();
    expect(screen.getAllByText('Try another photo')).toHaveLength(2);
  });

  it('shows computed evidence for no-face without inventing judged rows', async () => {
    mockAnalyse.mockResolvedValue(result(noFace));
    renderForm();
    select(photo());
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my photo' }));
    await waitFor(() => expect(screen.getByText('2.0')).not.toBeNull());
    expect(document.querySelectorAll('.score-row')).toHaveLength(4);
    expect(screen.getByText('No face found in this photo.')).not.toBeNull();
    expect(screen.getByText(/one clearly visible face to see the presentation scores/i)).not.toBeNull();
    expect(screen.getByText(/usable face is needed to review background/i)).not.toBeNull();
    expect(screen.getByText(/treat the score as approximate/i)).not.toBeNull();
  });

  it('explains client rejection without submitting the file', () => {
    renderForm();
    select(new File(['text'], 'notes.txt', { type: 'text/plain' }));
    expect(screen.getByRole('alert').textContent).toContain('JPEG, PNG or WebP');
    expect(mockAnalyse).not.toHaveBeenCalled();
  });

  it('offers a resumable retry after an extraction failure', async () => {
    mockAnalyse.mockRejectedValueOnce(new AnalysisError('extract', 'Review temporarily unavailable.', {
      canResume: true, photoId: 'photo-1',
    })).mockResolvedValueOnce(result(full));
    renderForm();
    select(photo());
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my photo' }));
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('Review temporarily unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('6.8')).not.toBeNull());
    expect(mockAnalyse).toHaveBeenCalledTimes(2);
    expect(mockAnalyse.mock.calls[1]?.[0]).toMatchObject({ resumePhotoId: 'photo-1' });
  });

  it.each([
    ['corrupt_file', 'Choose another photo if re-exporting does not work'],
    ['below_dimension_floor', 'at least 200 pixels'],
    ['mime_mismatch', 'Re-export this image'],
  ])('guides the user to replace a %s input instead of retrying it', async (code, guidance) => {
    mockAnalyse.mockRejectedValue(new AnalysisError('extract', 'This file cannot be reviewed.', {
      code, canResume: false, photoId: 'photo-1',
    }));
    renderForm();
    select(photo());
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my photo' }));
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
    expect(screen.getByRole('alert').textContent).toContain(guidance);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try another photo' })).not.toBeNull();
  });

  it('does not submit twice while a review is in flight', () => {
    mockAnalyse.mockImplementation((_input, deps: { onStage: (stage: string) => void }) => {
      deps.onStage('hashing');
      return new Promise(() => {});
    });
    renderForm();
    select(photo());
    const button = screen.getByRole('button', { name: 'Analyze my photo' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mockAnalyse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Analyze my photo' })).toBeNull();
  });
});
