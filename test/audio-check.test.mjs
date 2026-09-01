import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeAudioCheck, formatDbfs } from '../public/audio-check.js';

const frames = (count, rms, peak) => Array.from({ length: count }, () => ({ rms, peak }));

test('audio check keeps a quiet voice audible with a conservative gate', () => {
  const result = analyzeAudioCheck({
    ambientFrames: frames(12, 0.001, 0.004),
    speechFrames: frames(20, 0.008, 0.035),
  });

  assert.equal(result.outcome, 'quiet');
  assert.equal(result.reports.level, '偏小');
  assert.equal(result.reports.silence, '未检测到');
  assert.equal(result.recommendedGate, 2);
  assert.match(result.guidance, /靠近麦克风/);
  assert.match(result.guidance, /领夹麦、蓝牙耳机/);
});

test('audio check identifies a noisy room without recommending a gate above speech', () => {
  const result = analyzeAudioCheck({
    ambientFrames: frames(12, 0.02, 0.07),
    speechFrames: frames(20, 0.04, 0.22),
  });

  assert.equal(result.outcome, 'noisy');
  assert.equal(result.reports.noise, '偏高');
  assert.equal(result.recommendedGate, 18);
  assert.ok(result.recommendedGate / 1000 <= result.metrics.speechRms * 0.45);
  assert.match(result.guidance, /换一个输入设备/);
});

test('audio check gives clipping priority and reports the peak', () => {
  const speech = frames(19, 0.18, 0.72);
  speech.push({ rms: 0.3, peak: 1 });
  const result = analyzeAudioCheck({
    ambientFrames: frames(12, 0.002, 0.008),
    speechFrames: speech,
  });

  assert.equal(result.outcome, 'clipped');
  assert.equal(result.reports.level, '过响');
  assert.equal(result.reports.clipping, '检测到削波');
  assert.equal(result.metrics.speechPeak, 1);
  assert.match(result.guidance, /调低系统输入音量/);
});

test('audio check reports silence and does not invent a threshold', () => {
  const result = analyzeAudioCheck({
    ambientFrames: frames(12, 0.0002, 0.0008),
    speechFrames: frames(20, 0.0003, 0.001),
  });

  assert.equal(result.outcome, 'silent');
  assert.equal(result.reports.silence, '检测到静音');
  assert.equal(result.recommendedGate, null);
  assert.match(result.guidance, /选对输入设备/);
});

test('audio check reports a healthy signal and formats local aggregate levels', () => {
  const result = analyzeAudioCheck({
    ambientFrames: frames(12, 0.002, 0.006),
    speechFrames: frames(20, 0.05, 0.3),
  });

  assert.equal(result.outcome, 'good');
  assert.equal(result.reports.level, '合适');
  assert.equal(result.reports.noise, '正常');
  assert.equal(result.recommendedGate, 3);
  assert.equal(formatDbfs(0), '−∞ dBFS');
  assert.equal(formatDbfs(0.1), '-20 dBFS');
});
