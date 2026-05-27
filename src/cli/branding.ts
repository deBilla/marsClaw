// Branding helpers — banners for CLI entry points.
//
// Palette mirrors the marsClaw logo: orange Mars + claws, "mars" in orange,
// "Claw" in bold white. 256-colour orange (208) for a closer match than
// plain ANSI red; falls back to no-colour on non-TTY.

import { stdout } from 'node:process';

const tty = stdout.isTTY;
const wrap = (code: string, s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold   = (s: string): string => wrap('1', s);
export const dim    = (s: string): string => wrap('2', s);
export const orange = (s: string): string => wrap('38;5;208', s);
export const red    = (s: string): string => wrap('38;5;160', s);
export const white  = (s: string): string => wrap('1;97', s);

// Two talons curl INWARD at the top, bulge outward around Mars in the
// middle, open at the base — echoes the logo silhouette. The Mars sphere
// uses half-block characters (▄ █ ▀) so it reads as a round body, not a
// rectangle, at one character per cell.
const CLAW_TOP   = '╲              ╱';
const CLAW_LEFT  = '│    ';
const CLAW_RIGHT = '    │';
const CLAW_BOT   = '╱              ╲';
const MARS_TOP   = ' ▄██▄ ';
const MARS_MID   = '██████';
const MARS_BOT   = ' ▀██▀ ';
const BRAND      = `${orange('mars')}${white('Claw')}`;

/** Big banner — for `setup`. */
export function printBanner(subtitle = 'a personal chat agent — from mars'): void {
  console.log('');
  console.log(`  ${orange(CLAW_TOP)}    ${BRAND}`);
  console.log(`  ${orange(CLAW_LEFT)}${red(MARS_TOP)}${orange(CLAW_RIGHT)}`);
  console.log(`  ${orange(CLAW_LEFT)}${red(MARS_MID)}${orange(CLAW_RIGHT)}`);
  console.log(`  ${orange(CLAW_LEFT)}${red(MARS_BOT)}${orange(CLAW_RIGHT)}`);
  console.log(`  ${orange(CLAW_BOT)}    ${dim(subtitle)}`);
  console.log('');
}

/** Compact banner — for `start`. */
export function printRunningBanner(channels: string[], provider: string): void {
  const channelLine = channels.length ? channels.join(', ') : 'none';
  console.log('');
  console.log(`  ${orange(CLAW_TOP)}    ${BRAND}  ${dim('·')}  ${bold('running')}`);
  console.log(`  ${orange(CLAW_LEFT)}${red(MARS_TOP)}${orange(CLAW_RIGHT)}`);
  console.log(`  ${orange(CLAW_LEFT)}${red(MARS_MID)}${orange(CLAW_RIGHT)}`);
  console.log(`  ${orange(CLAW_LEFT)}${red(MARS_BOT)}${orange(CLAW_RIGHT)}`);
  console.log(`  ${orange(CLAW_BOT)}    ${dim(`provider: ${provider}  ·  channels: ${channelLine}`)}`);
  console.log('');
}
