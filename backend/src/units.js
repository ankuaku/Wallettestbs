import { config } from './config.js';

const pow10 = (n) => 10n ** BigInt(n);

/** Base units -> "12.3456" (at least 2 decimals, trailing zeros trimmed beyond that). */
export function formatUnits(units, decimals = config.network.token.decimals) {
  const u = BigInt(units);
  const one = pow10(decimals);
  const whole = u / one;
  const frac = (u % one).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${frac.padEnd(2, '0')}`;
}
