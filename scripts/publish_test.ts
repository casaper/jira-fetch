/** The one-time-code path, which cannot be exercised by publishing for real. */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { nextOtp, OTP_ENV, untilNextWindow } from './publish.ts';

Deno.test('the wait for a new code lands inside the next window, never zero', () => {
  // A TOTP steps every 30s on the Unix epoch. Zero would spin; 31 at the wrong moment would sit
  // out a whole extra window per package, which across seven packages is minutes of nothing.
  for (const second of [0, 1, 14, 29, 30, 31, 59, 60]) {
    const wait = untilNextWindow(second * 1000);
    assert(wait >= 1 && wait <= 31, `${second}s -> ${wait}`);
    // The window the wait lands in must not be the window it started in.
    assert(Math.floor((second + wait) / 30) > Math.floor(second / 30), `${second}s -> ${wait}`);
  }
});

Deno.test('no configured command means npm is left to ask for itself', async () => {
  const previous = Deno.env.get(OTP_ENV);
  Deno.env.delete(OTP_ENV);
  try {
    assertEquals(await nextOtp(new Set()), undefined);
    // Whitespace is not a command either.
    Deno.env.set(OTP_ENV, '   ');
    assertEquals(await nextOtp(new Set()), undefined);
  } finally {
    if (previous === undefined) Deno.env.delete(OTP_ENV);
    else Deno.env.set(OTP_ENV, previous);
  }
});

Deno.test('a configured command supplies the code, and it is marked spent', async () => {
  const previous = Deno.env.get(OTP_ENV);
  Deno.env.set(OTP_ENV, 'echo 123456');
  try {
    const used = new Set<string>();
    assertEquals(await nextOtp(used), '123456');
    // Recorded, so the next package does not hand npm a code it has already rejected. Asking
    // again here would block until the next window, which is exactly the intended behaviour and
    // exactly why this test stops at the bookkeeping.
    assert(used.has('123456'));
  } finally {
    if (previous === undefined) Deno.env.delete(OTP_ENV);
    else Deno.env.set(OTP_ENV, previous);
  }
});

Deno.test('a command stuck on one code gives up instead of waiting for ever', async () => {
  // The unbounded version of this loop hung the release outright: a command that stops advancing
  // — a cached entry, a stale vault — meant waiting for a new window that never came. A release
  // script that waits silently for ever is worse than one that stops and says why.
  const previous = Deno.env.get(OTP_ENV);
  Deno.env.set(OTP_ENV, 'echo 424242');
  const waits: number[] = [];
  try {
    const used = new Set(['424242']);
    const error = await assertRejects(
      () =>
        nextOtp(used, (seconds) => {
          waits.push(seconds);
          return Promise.resolve();
        }),
      Error,
    );
    assertStringIncludes(error.message, 'already used');
    // It waited, but a bounded number of times — the real sleep is injected away so this test
    // does not spend a minute proving it.
    assertEquals(waits.length, 2);
    for (const seconds of waits) assert(seconds >= 1 && seconds <= 31);
  } finally {
    if (previous === undefined) Deno.env.delete(OTP_ENV);
    else Deno.env.set(OTP_ENV, previous);
  }
});

Deno.test('a command that prints something else is refused, not passed to npm', async () => {
  const previous = Deno.env.get(OTP_ENV);
  Deno.env.set(OTP_ENV, 'echo "not-a-code"');
  try {
    const error = await assertRejects(() => nextOtp(new Set()), Error);
    assertStringIncludes(error.message, 'did not print a one-time code');
  } finally {
    if (previous === undefined) Deno.env.delete(OTP_ENV);
    else Deno.env.set(OTP_ENV, previous);
  }
});
