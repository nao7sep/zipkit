/** Native Quit is independent of asynchronous IPC. Preload retains issued job
 * submissions until main captures them before closing queue edit admission. */
import type { GuiOptions } from "../shared/spec.js";
import type { JobIntent } from "../shared/api.js";
type Patch = { options?: GuiOptions; intent?: JobIntent };

export function createJobEditSubmissions(send: (id: string, patch: Patch) => Promise<void>) {
  type Group = { latest: Patch; pending: Set<Promise<void>> };
  const inFlight = new Map<string, Group>();
  let captured: Array<{ id: string; patch: Patch; work: Promise<void>; failed: boolean }> | undefined;
  let capturing: Promise<void> | undefined;
  function issue(id: string, patch: Patch): Promise<void> {
    let work: Promise<void>;
    try { work = send(id, patch); } catch (error) { work = Promise.reject(error); }
    const group = inFlight.get(id) ?? { latest: {}, pending: new Set<Promise<void>>() };
    group.latest = { ...group.latest, ...patch };
    group.pending.add(work);
    inFlight.set(id, group);
    const finish = () => {
      group.pending.delete(work);
      if (group.pending.size === 0 && inFlight.get(id) === group) inFlight.delete(id);
    };
    void work.then(finish, finish);
    return work;
  }
  return {
    submit(id: string, patch: Patch): Promise<void> {
      if (captured) return Promise.reject(new Error("Job editing is suspended while the window closes"));
      return issue(id, patch);
    },
    capture(): Promise<void> {
      if (capturing) return capturing;
      if (captured) {
        // Retry the latest options AND intent, so neither a superseded failure
        // nor a newer edit to a different field can erase the captured values.
        for (const item of captured) if (item.failed) { item.failed = false; item.work = issue(item.id, item.patch); }
      } else captured = [...inFlight].map(([id, group]) => ({
        id, patch: { ...group.latest }, failed: false,
        work: Promise.allSettled(group.pending).then((results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }),
      }));
      const work = Promise.allSettled(captured.map((item) => item.work.catch((error) => { item.failed = true; throw error; }))).then((results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      });
      capturing = work;
      void work.then(() => { if (capturing === work) capturing = undefined; }, () => { if (capturing === work) capturing = undefined; });
      return work;
    },
    resume(): void { captured = undefined; capturing = undefined; },
  };
}
