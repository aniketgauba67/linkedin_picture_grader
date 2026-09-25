import { describe, expect, it } from 'vitest';

import { parseCsvObjects, parseCsvRecords } from './csv.js';

describe('CSV records', () => {
  it('preserves commas, doubled quotes, and quoted newlines', () => {
    const csv = '\uFEFFimage_id,creator,notes\r\nM007,"tranmautritam\n\n(site / user)","said ""hello"", then left"\r\nG001,Ada,plain\r\n';
    expect(parseCsvObjects(csv)).toEqual([
      { image_id: 'M007', creator: 'tranmautritam\n\n(site / user)', notes: 'said "hello", then left' },
      { image_id: 'G001', creator: 'Ada', notes: 'plain' },
    ]);
  });

  it('rejects an unterminated quoted field', () => {
    expect(() => parseCsvRecords('id,name\n1,"unfinished')).toThrow(/quoted field/);
  });
});
