const cancelled = new Set();

export class MigrationCancelledError extends Error {
  constructor(id) {
    super('Migration cancelled');
    this.name = 'MigrationCancelledError';
    this.migrationId = id;
  }
}

export function markCancelled(id) {
  if (id) cancelled.add(id);
}

export function clearCancelled(id) {
  if (id) cancelled.delete(id);
}

export function isCancelled(id) {
  return !!id && cancelled.has(id);
}

export function throwIfCancelled(mig) {
  const id = mig?.id || mig;
  if (isCancelled(id) || mig?.cancelRequested) {
    throw new MigrationCancelledError(id);
  }
}
