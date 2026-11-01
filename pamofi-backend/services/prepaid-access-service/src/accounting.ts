/** Unsigned RADIUS counter arithmetic. This module alone does not authorize access. */
const WORD = 1n << 32n;
const MAX_WORD = WORD - 1n;
function word(value: bigint): bigint {
  if (value < 0n || value > MAX_WORD) throw new RangeError('RADIUS word outside uint32');
  return value;
}
export function radiusCounter(gigawords: bigint, octets: bigint): bigint {
  return word(gigawords) * WORD + word(octets);
}
export function radiusLimit(bytes: bigint): { low: bigint; high: bigint } {
  if (bytes <= 0n || bytes > WORD * WORD - 1n) throw new RangeError('grant must fit a positive uint64');
  return { low: bytes % WORD, high: bytes / WORD };
}
export type Counters = { upload: bigint; download: bigint };
export type Observation = { highWater: Counters; additionalBytes: bigint; uncertain: boolean };
/** A lower observation may be a reset or a reordered packet. Preserve high water
 * and flag uncertainty: never release reserved capacity without evidence. */
export function observe(previous: Counters, next: Counters): Observation {
  for (const n of [previous.upload, previous.download, next.upload, next.download]) {
    if (n < 0n || n > WORD * WORD - 1n) throw new RangeError('counter outside uint64');
  }
  const upload = next.upload > previous.upload ? next.upload : previous.upload;
  const download = next.download > previous.download ? next.download : previous.download;
  return { highWater: { upload, download }, additionalBytes: upload - previous.upload + download - previous.download,
    uncertain: next.upload < previous.upload || next.download < previous.download };
}
/** Derive the timeout from the original absolute deadline, never replay a duration. */
export function remainingTimeoutSeconds(deadlineMs: number, nowMs: number, safetySeconds: number): number {
  if (!Number.isSafeInteger(deadlineMs) || !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(safetySeconds) || safetySeconds < 0) throw new RangeError('invalid deadline');
  return Math.max(0, Math.floor((deadlineMs - nowMs) / 1000) - safetySeconds);
}
