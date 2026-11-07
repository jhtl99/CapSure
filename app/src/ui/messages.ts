/**
 * What to tell the user when something goes wrong, in terms of what they can
 * do about it. Screens show these instead of raw error text.
 */

import { DeviceApiError, DeviceUnreachableError, TransferError } from '../device/client';
import { IntegrityError } from '../device/transfer';
import { InvalidAddressError } from '../device/validate';

export const SWITCH_HINT =
  'Turn the Wi-Fi switch on the hat on, then join the CapSure-XXXX network in Wi-Fi settings.';

export function describeError(e: unknown): string {
  if (e instanceof DeviceUnreachableError) {
    return `Can't reach the hat. ${SWITCH_HINT}`;
  }
  if (e instanceof InvalidAddressError) return e.message;
  if (e instanceof DeviceApiError) {
    if (e.code === 'version_mismatch') return e.message;
    if (e.status === 503 && e.code !== 'not_ready') {
      return 'The hat is busy with another phone. Close CapSure there, or wait a moment and try again.';
    }
    if (e.code === 'clip_not_found') {
      return 'That clip is no longer on the hat. Pull down to refresh.';
    }
    if (e.code === 'not_ready') return 'The hat is still starting up. Try again in a few seconds.';
    if (e.code === 'storage_error') {
      return "The hat couldn't read its SD card. Power-cycle it and try again.";
    }
    return `The hat reported an error: ${e.message}`;
  }
  if (e instanceof TransferError) {
    return 'The hat sent the wrong part of the clip. Tap to try again.';
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Same, for a download that stopped partway. */
export function describeDownloadError(e: unknown, fraction: number): string {
  if (e instanceof IntegrityError) {
    return (
      "The download didn't match the clip on the hat, so it was not confirmed " +
      'and the hat is still keeping it. Tap to download it again.'
    );
  }
  if (e instanceof DeviceUnreachableError) {
    const pct = Math.round(fraction * 100);
    return (
      `Stopped at ${pct}%. Move closer to the hat, check the Wi-Fi switch is on, ` +
      'and tap to resume.'
    );
  }
  return describeError(e);
}
