/**
 * Health thresholds – from config or env
 */

export function getThresholds() {
  return {
    cpuWarnPercent: Number(process.env.HEALTH_CPU_WARN) || 90,
    diskCritPercent: Number(process.env.HEALTH_DISK_CRIT) || 95,
    diskWarnPercent: Number(process.env.HEALTH_DISK_WARN) || 85,
  };
}
