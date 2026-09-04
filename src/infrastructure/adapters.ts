import type { Clock, IdGenerator } from '@/application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

const HEX = '0123456789abcdef';

function hex(byte: number): string {
  return `${HEX[(byte >> 4) & 0x0f] ?? '0'}${HEX[byte & 0x0f] ?? '0'}`;
}

// The design relies on uniqueness only: ordering comes from created_at, never
// from the identifier.
export class UuidV7Generator implements IdGenerator {
  next(): string {
    const random = crypto.getRandomValues(new Uint8Array(16));
    const bytes: number[] = Array.from(random);

    const timestamp = Date.now();
    for (let i = 0; i < 6; i += 1) {
      bytes[i] = Math.floor(timestamp / 2 ** (8 * (5 - i))) & 0xff;
    }
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    const chars = bytes.map((byte) => hex(byte));
    return [
      chars.slice(0, 4).join(''),
      chars.slice(4, 6).join(''),
      chars.slice(6, 8).join(''),
      chars.slice(8, 10).join(''),
      chars.slice(10, 16).join(''),
    ].join('-');
  }
}
