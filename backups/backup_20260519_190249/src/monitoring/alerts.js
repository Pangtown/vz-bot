/**
 * Alerts – format health results and optional callback to post (e.g. Slack)
 */

let onAlertCallback = null;

export function setAlertCallback(fn) {
  onAlertCallback = fn;
}

export async function emitAlerts(healthResult) {
  const alerts = healthResult?.summary?.alerts || [];
  if (alerts.length === 0) return;
  const message = alerts.map(a => a.message).join('; ');
  if (onAlertCallback) await onAlertCallback(message, healthResult);
  return message;
}
