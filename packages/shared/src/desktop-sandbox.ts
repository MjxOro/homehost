/** Keep HTTP and iframe policies identical. Never add allow-same-origin. */
export const DESKTOP_SANDBOX =
  "allow-scripts allow-forms allow-pointer-lock allow-popups allow-modals allow-downloads";
export const DESKTOP_CSP = `sandbox ${DESKTOP_SANDBOX}`;

export const DESKTOP_BRIDGE_CHANNEL = "homehost-desktop-input-v1";
