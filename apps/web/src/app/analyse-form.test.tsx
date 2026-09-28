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
  review: {
    axes: { sharpness: 5, lighting: 5, resolution: 4 },
    context: 'corporate',
    fixes: [],
    confidence: 0.55,
    weightsVersion: '2026-09-24.1',
    coverage: 'partial',
  },
};

const detectorDisagreement: AnalysisOutcome = {
  status: 'partial',
  review: {
    axes: { sharpness: 5, lighting: 5, resolution: 5, framing: 2 },
    context: 'corporate',
    fixes: [{ axis: 'framing', severity: 'high', message: 'Move closer to the camera.' }],
    confidence: 0.4,
    weightsVersion: '2026-09-24.1',
    coverage: 'partial',
  },
};

const multipleFaces: AnalysisOutcome = {
  status: 'declined',
  reason: 'multiple_faces',
  message: 'Multiple faces were detected in this photo. Choose a photo with one clearly visible person.',
  review: detectorDisagreement.review,
};

function result(outcome: AnalysisOutcome, detectedFaceCount = 1): {
  outcome: AnalysisOutcome;
  extract: { features: { faceCount: number } };
} {
  // The form uses the raw detector count only for descriptive copy.
  return { outcome, extract: { features: { faceCount: detectedFaceCount } } };
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
    mockAnalyse.mockResolvedValue(result(noFace, 0));
    renderForm();
    select(photo());
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my photo' }));
    await waitFor(() => expect(screen.getByText('Overall score unavailable')).not.toBeNull());
    expect(document.querySelectorAll('.score-row')).toHaveLength(3);
    expect(screen.getByText('No face found in this photo.')).not.toBeNull();
    expect(screen.getByText(/one clearly visible face to see the presentation scores/i)).not.toBeNull();
    expect(screen.getByText(/usable face is needed to review background/i)).not.toBeNull();
    expect(screen.getByText(/measured image-quality details may be less certain/i)).not.toBeNull();
    expect(screen.getByText('Presentation').closest('section')?.textContent).toContain('0 of 4 reviewed');
    expect(screen.queryByText(/\/ 10/)).toBeNull();
  });

  it('renders a single-face detector/judge disagreement as a score-free partial review', async () => {
    mockAnalyse.mockResolvedValue(result(detectorDisagreement, 1));
    renderForm();
    select(photo('single-face-disagreement.jpeg'));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my photo' }));
    await waitFor(() => expect(screen.getByText('Overall score unavailable')).not.toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Partial photo review.');
    expect(screen.getByText('Image quality').closest('section')?.textContent).toContain('4 of 4 reviewed');
    expect(screen.getByText('Presentation').closest('section')?.textContent).toContain('0 of 4 reviewed');
    expect(document.querySelectorAll('.score-row')).toHaveLength(4);
    expect(screen.getByText('Move closer to the camera.')).not.toBeNull();
    expect(screen.queryByText(/multiple faces were detected in this photo/i)).toBeNull();
    const rendered = document.body.textContent ?? '';
    expect(rendered).not.toContain('7.6 / 10');
    expect(rendered).not.toContain('Overall photo score');
    expect(rendered).not.toContain('Scored for a corporate audience');
    expect(rendered).not.toContain('No face found');
    expect(rendered).not.toContain('face fills 0%');
  });

  it('explicitly rejects IMG_0918 as a group photo with no overall score', async () => {
    mockAnalyse.mockResolvedValue(result(multipleFaces, 3));
    renderForm();
    select(photo('IMG_0918.jpeg'));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze my photo' }));
    await waitFor(() => expect(screen.getByText('Overall score unavailable')).not.toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Multiple faces found in this photo.');
    expect(screen.getByText('Image quality').closest('section')?.textContent).toContain('4 of 4 reviewed');
    expect(screen.getByText('Presentation').closest('section')?.textContent).toContain('0 of 4 reviewed');
    expect(screen.getByText(/Choose or crop a photo so only one person remains in the frame/i)).not.toBeNull();
    expect(document.querySelectorAll('.score-row')).toHaveLength(4);
    const rendered = document.body.textContent ?? '';
    expect(rendered).not.toContain('/ 10');
    expect(rendered).not.toContain('No face found');
    expect(rendered).not.toContain('Overall photo score');
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
