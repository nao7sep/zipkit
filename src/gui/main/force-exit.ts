/**
 * Ending the process when quit left work behind. Electron's and Node's exit wait
 * for every worker and threadpool call to return, and one stuck in native I/O
 * (a hung network volume, a worker inside SQLite) never does, so the ordinary
 * exit can hang with no window left. The OS termination primitive does not wait.
 * Used only after quit's bounded steps have run, so the queue save, the log and
 * the backup history have had their chance.
 */
export function forceExitProcess(): void {
  process.kill(process.pid, "SIGKILL");
}
