export function parseSupervisorPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

export function isSupervisorAttached(expectedPid, {
  currentParentPid = process.ppid,
  signal = process.kill,
} = {}) {
  if (!expectedPid || currentParentPid !== expectedPid) return false;
  try {
    signal(expectedPid, 0);
    return true;
  } catch {
    return false;
  }
}
