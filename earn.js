'use strict';

// ---------------------------------------------------------------------------
// Server-authoritative earning rule. Pure function -> easy to unit-test.
//
// The browser sends a heartbeat ONLY while it can prove the viewer is really
// watching: the Rumble player reports "playing", playback time is advancing,
// and the tab is visible and focused. The server cannot see inside the
// cross-origin player, so it does not trust the browser blindly. It enforces
// two hard rules that make farming pointless:
//
//   1. RATE CAP: at most POINTS_PER_TICK per TICK_SECONDS of real wall-clock
//      time. Replaying the heartbeat 1000x/second earns nothing extra.
//
//   2. CONTINUITY: points accrue only while heartbeats keep arriving. If the
//      stream of heartbeats stops for longer than MAX_GAP_MS (tab closed,
//      paused, hidden, network drop), the earning clock RESETS -- the gap is
//      never paid out, and the next point requires a fresh full tick of
//      continuous watching. So a closed tab cannot bank time, and pausing
//      cannot be "caught up" on resume.
//
// The very first heartbeat of a session starts the clock but pays nothing:
// you must actually watch a full tick before the first point.
// ---------------------------------------------------------------------------
function applyHeartbeat(user, now, cfg) {
  const tickMs = cfg.TICK_SECONDS * 1000;
  // Small tolerance so ordinary timer jitter doesn't cost a legitimate point.
  const minGap = tickMs - 1500;
  const maxGap = cfg.MAX_GAP_MS;

  const lastSeen = user.lastSeenAt || 0;
  const gap = now - lastSeen;

  let awarded = false;
  let granted = 0;
  let reason;

  // Fresh session, or resumed after a break longer than MAX_GAP_MS:
  // (re)start the clock and pay nothing for the gap.
  if (!lastSeen || gap > maxGap) {
    user.lastSeenAt = now;
    user.lastTickAt = now;
    reason = 'clock-start';
  } else {
    user.lastSeenAt = now;
    // Continuous watching: award once a full tick of real time has elapsed.
    if (now - (user.lastTickAt || 0) >= minGap) {
      user.lastTickAt = now;
      user.points += cfg.POINTS_PER_TICK;
      user.watchSeconds = (user.watchSeconds || 0) + cfg.TICK_SECONDS;
      awarded = true;
      granted = cfg.POINTS_PER_TICK;
      reason = 'tick';
    } else {
      reason = 'too-soon';
    }
  }

  // Whole seconds of continuous watching still needed before the next point.
  // Freezes naturally while heartbeats stop (nothing advances lastTickAt), and
  // resets to a full tick after a break, because a break resets lastTickAt.
  const secondsToNext = Math.max(0, Math.ceil((tickMs - (now - user.lastTickAt)) / 1000));

  return { awarded, granted, points: user.points, reason, secondsToNext };
}

module.exports = { applyHeartbeat };
