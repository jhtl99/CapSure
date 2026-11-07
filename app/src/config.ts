/**
 * Where the device lives.
 *
 * Two modes, and you will use the mock far more than the real thing:
 *
 *   MOCK   run `python3 mock-device/serve.py` on your laptop and put your
 *          laptop's LAN IP here. On an iOS simulator, localhost works.
 *          Find it with:  ipconfig getifaddr en0
 *
 *   DEVICE join the CapSure-XXXX Wi-Fi network, then use 192.168.4.1.
 *
 * The connect screen lets you type this at runtime too, so you do not have to
 * edit and reload every time your laptop gets a new DHCP lease.
 */

export const DEVICE_URL = 'http://192.168.4.1';
export const MOCK_URL = 'http://localhost:8080';

/** What the connect screen starts with. */
export const DEFAULT_BASE_URL = MOCK_URL;

/** Requests to the device time out fast: it is on the same Wi-Fi, or it is gone. */
export const REQUEST_TIMEOUT_MS = 5000;

/**
 * The first request after the phone joins the hat's network. DHCP and ARP are
 * still settling, and the ESP32 is answering between SD writes.
 */
export const CONNECT_TIMEOUT_MS = 12000;

/** Missed status polls in a row before the app says the device is gone. */
export const STATUS_MISSES_BEFORE_LOST = 2;

/** How often the gallery re-checks the device while it is open. */
export const STATUS_POLL_MS = 5000;

/**
 * Clip chunks downloaded at once, each on its own connection. Matches
 * XFER_WORKERS in the firmware. Set to 1 for the old one-at-a-time behaviour,
 * or when using the mock without --multi-client (it answers overlaps with 503).
 */
export const DOWNLOAD_PARALLEL = 4;
