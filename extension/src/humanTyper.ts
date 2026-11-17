import { DEFAULT_TYPING_PROFILE, TypingProfile } from '../../shared/types';

export interface KeyPosition {
  hand: 'L' | 'R';
  finger: number;
  row: number;
  col: number;
}

export interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  shifted: boolean;
}

export type KeystrokeStep =
  | {
      kind: 'key';
      char: string;
      delayBeforeMs: number;
      keyDef: KeyDefinition;
      isTypo?: boolean;
    }
  | {
      kind: 'enter';
      char: '\n';
      delayBeforeMs: number;
    }
  | {
      kind: 'backspace';
      char: '\b';
      delayBeforeMs: number;
    }
  | {
      kind: 'insertText';
      char: string;
      delayBeforeMs: number;
    };

export class JobCancelledError extends Error {
  constructor(message = 'Job cancelled by user') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export const QWERTY_LAYOUT: Record<string, KeyPosition> = {
  // Number row (row 0)
  '1': { hand: 'L', finger: 1, row: 0, col: 1 },
  '2': { hand: 'L', finger: 2, row: 0, col: 2 },
  '3': { hand: 'L', finger: 3, row: 0, col: 3 },
  '4': { hand: 'L', finger: 4, row: 0, col: 4 },
  '5': { hand: 'L', finger: 4, row: 0, col: 5 },
  '6': { hand: 'R', finger: 7, row: 0, col: 6 },
  '7': { hand: 'R', finger: 7, row: 0, col: 7 },
  '8': { hand: 'R', finger: 8, row: 0, col: 8 },
  '9': { hand: 'R', finger: 9, row: 0, col: 9 },
  '0': { hand: 'R', finger: 10, row: 0, col: 10 },
  // Top alpha row (row 1)
  q: { hand: 'L', finger: 1, row: 1, col: 1 },
  w: { hand: 'L', finger: 2, row: 1, col: 2 },
  e: { hand: 'L', finger: 3, row: 1, col: 3 },
  r: { hand: 'L', finger: 4, row: 1, col: 4 },
  t: { hand: 'L', finger: 4, row: 1, col: 5 },
  y: { hand: 'R', finger: 7, row: 1, col: 6 },
  u: { hand: 'R', finger: 7, row: 1, col: 7 },
  i: { hand: 'R', finger: 8, row: 1, col: 8 },
  o: { hand: 'R', finger: 9, row: 1, col: 9 },
  p: { hand: 'R', finger: 10, row: 1, col: 10 },
  // Home row (row 2)
  a: { hand: 'L', finger: 1, row: 2, col: 1 },
  s: { hand: 'L', finger: 2, row: 2, col: 2 },
  d: { hand: 'L', finger: 3, row: 2, col: 3 },
  f: { hand: 'L', finger: 4, row: 2, col: 4 },
  g: { hand: 'L', finger: 4, row: 2, col: 5 },
  h: { hand: 'R', finger: 7, row: 2, col: 6 },
  j: { hand: 'R', finger: 7, row: 2, col: 7 },
  k: { hand: 'R', finger: 8, row: 2, col: 8 },
  l: { hand: 'R', finger: 9, row: 2, col: 9 },
  // Bottom row (row 3)
  z: { hand: 'L', finger: 1, row: 3, col: 1 },
  x: { hand: 'L', finger: 2, row: 3, col: 2 },
  c: { hand: 'L', finger: 3, row: 3, col: 3 },
  v: { hand: 'L', finger: 4, row: 3, col: 4 },
  b: { hand: 'L', finger: 4, row: 3, col: 5 },
  n: { hand: 'R', finger: 7, row: 3, col: 6 },
  m: { hand: 'R', finger: 7, row: 3, col: 7 },
};

export const QWERTY_NEIGHBORS: Record<string, string[]> = {
  q: ['w', 'a'],
  w: ['q', 'e', 'a', 's'],
  e: ['w', 'r', 's', 'd'],
  r: ['e', 't', 'd', 'f'],
  t: ['r', 'y', 'f', 'g'],
  y: ['t', 'u', 'g', 'h'],
  u: ['y', 'i', 'h', 'j'],
  i: ['u', 'o', 'j', 'k'],
  o: ['i', 'p', 'k', 'l'],
  p: ['o', 'l'],
  a: ['q', 'w', 's', 'z'],
  s: ['w', 'e', 'a', 'd', 'z', 'x'],
  d: ['e', 'r', 's', 'f', 'x', 'c'],
  f: ['r', 't', 'd', 'g', 'c', 'v'],
  g: ['t', 'y', 'f', 'h', 'v', 'b'],
  h: ['y', 'u', 'g', 'j', 'b', 'n'],
  j: ['u', 'i', 'h', 'k', 'n', 'm'],
  k: ['i', 'o', 'j', 'l', 'm'],
  l: ['o', 'p', 'k'],
  z: ['a', 's', 'x'],
  x: ['s', 'd', 'z', 'c'],
  c: ['d', 'f', 'x', 'v'],
  v: ['f', 'g', 'c', 'b'],
  b: ['g', 'h', 'v', 'n'],
  n: ['h', 'j', 'b', 'm'],
  m: ['j', 'k', 'n'],
};

const SYMBOL_KEY_MAP: Record<string, { code: string; vk: number; shifted: boolean }> = {
  '`': { code: 'Backquote', vk: 192, shifted: false },
  '~': { code: 'Backquote', vk: 192, shifted: true },
  '!': { code: 'Digit1', vk: 49, shifted: true },
  '@': { code: 'Digit2', vk: 50, shifted: true },
  '#': { code: 'Digit3', vk: 51, shifted: true },
  '$': { code: 'Digit4', vk: 52, shifted: true },
  '%': { code: 'Digit5', vk: 53, shifted: true },
  '^': { code: 'Digit6', vk: 54, shifted: true },
  '&': { code: 'Digit7', vk: 55, shifted: true },
  '*': { code: 'Digit8', vk: 56, shifted: true },
  '(': { code: 'Digit9', vk: 57, shifted: true },
  ')': { code: 'Digit0', vk: 48, shifted: true },
  '-': { code: 'Minus', vk: 189, shifted: false },
  _: { code: 'Minus', vk: 189, shifted: true },
  '=': { code: 'Equal', vk: 187, shifted: false },
  '+': { code: 'Equal', vk: 187, shifted: true },
  '[': { code: 'BracketLeft', vk: 219, shifted: false },
  '{': { code: 'BracketLeft', vk: 219, shifted: true },
  ']': { code: 'BracketRight', vk: 221, shifted: false },
  '}': { code: 'BracketRight', vk: 221, shifted: true },
  '\\': { code: 'Backslash', vk: 220, shifted: false },
  '|': { code: 'Backslash', vk: 220, shifted: true },
  ';': { code: 'Semicolon', vk: 186, shifted: false },
  ':': { code: 'Semicolon', vk: 186, shifted: true },
  "'": { code: 'Quote', vk: 222, shifted: false },
  '"': { code: 'Quote', vk: 222, shifted: true },
  ',': { code: 'Comma', vk: 188, shifted: false },
  '<': { code: 'Comma', vk: 188, shifted: true },
  '.': { code: 'Period', vk: 190, shifted: false },
  '>': { code: 'Period', vk: 190, shifted: true },
  '/': { code: 'Slash', vk: 191, shifted: false },
  '?': { code: 'Slash', vk: 191, shifted: true },
};

export function getKeyDefinition(char: string): KeyDefinition | null {
  if (char.length !== 1) {
    return null;
  }

  if (char === ' ') {
    return {
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
      shifted: false,
    };
  }

  const codePoint = char.charCodeAt(0);
  if (codePoint >= 97 && codePoint <= 122) {
    const upper = char.toUpperCase();
    return {
      key: char,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      shifted: false,
    };
  }

  if (codePoint >= 65 && codePoint <= 90) {
    return {
      key: char,
      code: `Key${char}`,
      windowsVirtualKeyCode: codePoint,
      shifted: true,
    };
  }

  if (codePoint >= 48 && codePoint <= 57) {
    return {
      key: char,
      code: `Digit${char}`,
      windowsVirtualKeyCode: codePoint,
      shifted: false,
    };
  }

  const symbol = SYMBOL_KEY_MAP[char];
  if (symbol) {
    return {
      key: char,
      code: symbol.code,
      windowsVirtualKeyCode: symbol.vk,
      shifted: symbol.shifted,
    };
  }

  return null;
}

export function randomBetween(min: number, max: number, rng: () => number = Math.random): number {
  return min + rng() * (max - min);
}

function sampleNormal(mean: number, stdDev: number, rng: () => number): number {
  const u1 = Math.max(1e-7, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

function isPrintableAscii(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return code >= 32 && code <= 126;
}

function segmentGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

export function buildKeystrokePlan(
  text: string,
  profileOverride?: Partial<TypingProfile>,
  rng: () => number = Math.random
): KeystrokeStep[] {
  const profile: TypingProfile = {
    ...DEFAULT_TYPING_PROFILE,
    ...profileOverride,
    readingDelayMs: profileOverride?.readingDelayMs ?? DEFAULT_TYPING_PROFILE.readingDelayMs,
  };

  const graphemes = segmentGraphemes(text);
  const steps: KeystrokeStep[] = [];
  let prevLowerChar: string | null = null;
  let pendingCognitivePauseMs = 0;

  for (let i = 0; i < graphemes.length; i += 1) {
    const grapheme = graphemes[i];
    const effectiveWpm = Math.max(18, sampleNormal(profile.wpmMean, profile.wpmStdDev, rng));
    let baseDelayMs = 60000 / (effectiveWpm * 5);
    baseDelayMs = Math.max(35, Math.min(450, baseDelayMs));

    const lowerCurr = grapheme.toLowerCase();
    const prevPos = prevLowerChar ? QWERTY_LAYOUT[prevLowerChar] : undefined;
    const currPos = QWERTY_LAYOUT[lowerCurr];

    if (prevPos && currPos) {
      if (prevLowerChar === lowerCurr) {
        baseDelayMs *= 0.75;
      } else if (prevPos.hand !== currPos.hand) {
        baseDelayMs *= 0.85;
      } else if (prevPos.finger === currPos.finger) {
        baseDelayMs *= 1.18;
      }
    }

    const keyDef = getKeyDefinition(grapheme);
    if (keyDef?.shifted) {
      baseDelayMs += randomBetween(25, 60, rng);
    }

    let delayBeforeMs =
      i === 0
        ? Math.round(randomBetween(75, 200, rng))
        : Math.round(baseDelayMs + pendingCognitivePauseMs);
    pendingCognitivePauseMs = 0;

    // Simulate natural adjacent-key typo + Backspace recovery on alphabetic characters
    const neighbors = grapheme.length === 1 ? QWERTY_NEIGHBORS[lowerCurr] : undefined;
    if (neighbors && neighbors.length > 0 && profile.typoRate > 0 && rng() < profile.typoRate) {
      const neighborLower = neighbors[Math.floor(rng() * neighbors.length)];
      const typoChar =
        grapheme !== lowerCurr ? neighborLower.toUpperCase() : neighborLower;
      const typoKeyDef = getKeyDefinition(typoChar);

      if (typoKeyDef) {
        steps.push({
          kind: 'key',
          char: typoChar,
          delayBeforeMs,
          keyDef: typoKeyDef,
          isTypo: true,
        });
        steps.push({
          kind: 'backspace',
          char: '\b',
          delayBeforeMs: Math.round(randomBetween(140, 320, rng)),
        });
        delayBeforeMs = Math.round(randomBetween(80, 160, rng));
      }
    }

    if (grapheme === '\n' || grapheme === '\r\n') {
      steps.push({
        kind: 'enter',
        char: '\n',
        delayBeforeMs,
      });
    } else if (isPrintableAscii(grapheme) && keyDef) {
      steps.push({
        kind: 'key',
        char: grapheme,
        delayBeforeMs,
        keyDef,
      });
    } else {
      steps.push({
        kind: 'insertText',
        char: grapheme,
        delayBeforeMs: delayBeforeMs + Math.round(randomBetween(180, 420, rng)),
      });
    }

    // Queue cognitive & punctuation pauses before the next character
    if (grapheme === ' ') {
      pendingCognitivePauseMs += randomBetween(60, 150, rng);
      if (rng() < 0.06) {
        pendingCognitivePauseMs += randomBetween(550, 1400, rng);
      }
    } else if (grapheme === ',' || grapheme === ';' || grapheme === ':' || grapheme === '-') {
      pendingCognitivePauseMs += randomBetween(220, 500, rng);
    } else if (
      grapheme === '.' ||
      grapheme === '!' ||
      grapheme === '?' ||
      grapheme === '\n' ||
      grapheme === '\r\n'
    ) {
      pendingCognitivePauseMs += randomBetween(400, 900, rng);
    }

    prevLowerChar = lowerCurr;
  }

  return steps;
}

export function simulatePlanOutput(steps: KeystrokeStep[]): string {
  const buffer: string[] = [];
  for (const step of steps) {
    if (step.kind === 'key' || step.kind === 'insertText') {
      buffer.push(step.char);
    } else if (step.kind === 'enter') {
      buffer.push('\n');
    } else if (step.kind === 'backspace') {
      buffer.pop();
    }
  }
  return buffer.join('');
}

export interface ExecutePlanOptions {
  tabId: number;
  steps: KeystrokeStep[];
  shouldAbort?: () => boolean;
  onProgress?: (completedSteps: number, totalSteps: number) => void;
  rng?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendCdpCommand(
  tabId: number,
  method: string,
  commandParams?: Record<string, unknown>
): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, commandParams);
}

export async function executeKeystrokePlan({
  tabId,
  steps,
  shouldAbort,
  onProgress,
  rng = Math.random,
}: ExecutePlanOptions): Promise<void> {
  const total = steps.length;
  for (let i = 0; i < total; i += 1) {
    if (shouldAbort?.()) {
      throw new JobCancelledError();
    }

    const step = steps[i];
    const holdMs = Math.round(randomBetween(14, 34, rng));
    const preDelayMs = Math.max(0, step.delayBeforeMs - holdMs);

    if (preDelayMs > 0) {
      await sleep(preDelayMs);
    }
    if (shouldAbort?.()) {
      throw new JobCancelledError();
    }

    if (step.kind === 'key') {
      const { keyDef } = step;
      const modifiers = keyDef.shifted ? 8 : 0;

      if (keyDef.shifted) {
        await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'Shift',
          code: 'ShiftLeft',
          windowsVirtualKeyCode: 16,
          nativeVirtualKeyCode: 16,
          modifiers: 8,
        });
      }

      await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
        nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
        modifiers,
      });

      await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'char',
        text: step.char,
        unmodifiedText: step.char,
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
        nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
        modifiers,
      });

      await sleep(holdMs);

      await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
        nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
        modifiers,
      });

      if (keyDef.shifted) {
        await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Shift',
          code: 'ShiftLeft',
          windowsVirtualKeyCode: 16,
          nativeVirtualKeyCode: 16,
          modifiers: 0,
        });
      }
    } else if (step.kind === 'enter') {
      await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'char',
        text: '\r',
        unmodifiedText: '\r',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await sleep(holdMs);
      await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } else if (step.kind === 'backspace') {
      await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await sleep(holdMs);
      await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    } else if (step.kind === 'insertText') {
      await sleep(holdMs);
      await sendCdpCommand(tabId, 'Input.insertText', {
        text: step.char,
      });
    }

    onProgress?.(i + 1, total);
  }
}
