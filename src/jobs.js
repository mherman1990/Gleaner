// One ingest at a time across the scheduler and the API. A nightly batch run can poll for hours; a second
// ingest started meanwhile would collect the same in-progress batch and apply its results twice.
let current = null;

export const busy = () => current;

/** Run fn unless another exclusive job is running; throws { busy } if one is. */
export async function exclusive(name, fn) {
  if (current) throw Object.assign(new Error(`busy: ${current}`), { busy: current });
  current = name;
  try { return await fn(); } finally { current = null; }
}
