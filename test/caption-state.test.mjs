import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTION_STATES,
  applyCaptionPatch,
  createFinalCaption,
  draftView,
  isNewerCaptionRevision,
} from '../public/caption-state.js';

test('draft view keeps finalized tokens stable while only the changing tail rewrites', () => {
  const first = draftView({ finalOrig: 'Hello ', interimOrig: 'worl' });
  const second = draftView({ finalOrig: 'Hello ', interimOrig: 'world' });

  assert.equal(first.state, CAPTION_STATES.DRAFT);
  assert.equal(first.original.stable, second.original.stable);
  assert.notEqual(first.original.changing, second.original.changing);
});

test('final caption corrections increment revision and reject stale async translation', () => {
  const final = createFinalCaption({ id: 1, orig: 'Original', trans: '' });
  const corrected = applyCaptionPatch(final, { orig: 'Corrected' }, {
    expectedRevision: 1,
    state: CAPTION_STATES.CORRECTED,
  });
  assert.equal(corrected.applied, true);
  assert.equal(corrected.caption.revision, 2);
  assert.equal(corrected.caption.state, CAPTION_STATES.CORRECTED);

  const lateTranslation = applyCaptionPatch(corrected.caption, { trans: 'Old translation' }, {
    expectedRevision: 1,
  });
  assert.equal(lateTranslation.applied, false);
  assert.equal(lateTranslation.reason, 'stale');
  assert.equal(lateTranslation.caption.orig, 'Corrected');
  assert.equal(lateTranslation.caption.trans, '');
});

test('revision ordering accepts only a strictly newer positive integer', () => {
  assert.equal(isNewerCaptionRevision(2, 3), true);
  assert.equal(isNewerCaptionRevision(2, 2), false);
  assert.equal(isNewerCaptionRevision(2, 1), false);
  assert.equal(isNewerCaptionRevision(2, 2.5), false);
});
