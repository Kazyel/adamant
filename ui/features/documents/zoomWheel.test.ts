import assert from 'node:assert/strict';
import test from 'node:test';
import { createZoomTransition, listenForZoomWheel } from './zoomWheel.ts';

void test('Ctrl+wheel scales proportionally within limits without consuming ordinary scrolling', () => {
  const target = new EventTarget();
  const changes: number[] = [];
  const release = listenForZoomWheel(target, 1, (zoom) => changes.push(zoom));
  const wheel = (deltaY: number, ctrlKey = true, deltaMode = 0) => {
    const event = Object.assign(new Event('wheel', { cancelable: true }), {
      deltaY,
      ctrlKey,
      deltaMode,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  assert.equal(wheel(-120, false), false);
  assert.equal(wheel(0), false);
  assert.deepEqual(changes, []);
  assert.equal(wheel(-1), true);
  assert.ok(changes[0] > 1 && changes[0] < 1.01, 'A trackpad pixel must not jump by 25%.');
  assert.equal(wheel(-120), true);
  assert.ok(changes[1] > 1.1 && changes[1] < 1.4);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(wheel(-120), true);
  }
  assert.equal(changes.at(-1), 2);
  const countAtLimit = changes.length;
  assert.equal(wheel(-120), true);
  assert.equal(changes.length, countAtLimit);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(wheel(120), true);
  }
  assert.equal(changes.at(-1), 0.5);
  assert.equal(wheel(-1, true, 1), true);
  assert.ok(changes.at(-1)! > 0.51 && changes.at(-1)! < 0.52);

  release();
  assert.equal(wheel(-120), false);
  assert.ok(changes.at(-1)! < 0.52);
});

function animationClock() {
  let now = 0;
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const motion = { matches: false };
  const view = {
    performance: { now: () => now },
    matchMedia: () => motion,
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  };
  return {
    view,
    motion,
    frames,
    advance(time: number) {
      now = time;
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) {
        frame(time);
      }
    },
  };
}

void test('zoom transitions interpolate, reverse from the displayed scale and stop on disposal', () => {
  const clock = animationClock();
  const scales: number[] = [];
  const transition = createZoomTransition(clock.view, 1, (zoom) => scales.push(zoom));
  transition.zoomTo(2);
  assert.deepEqual(scales, []);
  clock.advance(20);
  assert.ok(scales[0] > 1 && scales[0] < 2);
  transition.zoomTo(0.5);
  clock.advance(20);
  assert.equal(scales[1], scales[0], 'Reversing must start at the last displayed scale.');
  clock.advance(40);
  assert.ok(scales[2] < scales[1] && scales[2] > 0.5);
  clock.advance(120);
  assert.equal(scales.at(-1), 0.5);
  assert.equal(clock.frames.size, 0);

  transition.zoomTo(1);
  transition.dispose();
  clock.advance(200);
  assert.equal(scales.at(-1), 0.5);
});

void test('reduced motion applies zoom immediately and cancels an in-flight transition', () => {
  const clock = animationClock();
  const scales: number[] = [];
  const transition = createZoomTransition(clock.view, 1, (zoom) => scales.push(zoom));
  transition.zoomTo(2);
  clock.advance(20);
  clock.motion.matches = true;
  transition.zoomTo(0.5);
  assert.equal(scales.at(-1), 0.5);
  assert.equal(clock.frames.size, 0);
  clock.advance(120);
  assert.equal(scales.length, 2);
  transition.dispose();
});
