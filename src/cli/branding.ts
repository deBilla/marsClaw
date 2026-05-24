// Branding helpers — banners for CLI entry points.

import { stdout } from 'node:process';

const tty = stdout.isTTY;
const wrap = (code: string, s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = (s: string): string => wrap('1', s);
export const dim  = (s: string): string => wrap('2', s);
export const cyan = (s: string): string => wrap('36', s);

const CLAWS = '╲ ╲ ╲';
const BRAND = `${cyan('nothing')}${bold(cyan('Claw'))}`;

/** Big banner — for `setup`. */
export function printBanner(subtitle = 'a personal chat agent — nothing more'): void {
  console.log('');
  console.log(`  ${cyan(CLAWS)}    ${BRAND}`);
  console.log(`   ${cyan(CLAWS)}   ${dim(subtitle)}`);
  console.log('');
}

/** Compact banner — for `start`. */
export function printRunningBanner(channels: string[], provider: string): void {
  const channelLine = channels.length ? channels.join(', ') : 'none';
  console.log('');
  console.log(`  ${cyan(CLAWS)}    ${BRAND}  ${dim('·')}  ${bold('running')}`);
  console.log(`   ${cyan(CLAWS)}   ${dim(`provider: ${provider}  ·  channels: ${channelLine}`)}`);
  console.log('');
}
