import { describe, expect, it, vi } from "vitest";
import { createSdkClient, type HostProcess } from "../../../src/gui/main/sdk-client.js";
import type { HostReply, HostRequest } from "../../../src/gui/main/sdk-host.js";

/** A host process the test drives by hand. */
function fakeHost() {
  const sent: HostRequest[] = [];
  let reply: (message: HostReply) => void = () => {};
  let exit: (code: number) => void = () => {};
  const process: HostProcess & { killed: boolean } = {
    killed: false,
    postMessage: (request) => { sent.push(request); },
    onMessage: (listener) => { reply = listener; },
    onExit: (listener) => { exit = listener; },
    kill() { this.killed = true; },
  };
  return { process, sent, reply: (message: HostReply) => reply(message), exit: (code: number) => exit(code) };
}

describe("createSdkClient", () => {
  it("starts the host on the first call and settles each call from its own reply", async () => {
    const host = fakeHost();
    const spawn = vi.fn(() => host.process);
    const sdk = createSdkClient(spawn);
    expect(spawn).not.toHaveBeenCalled();
    const onEvent = vi.fn();
    const first = sdk.call("pathKinds", [["/a"]], { onEvent });
    const second = sdk.call("verify", ["/a.zip", "zipkit.json"]);
    expect(spawn).toHaveBeenCalledOnce();
    expect(host.sent).toEqual([
      { type: "call", id: 1, op: "pathKinds", args: [["/a"]] },
      { type: "call", id: 2, op: "verify", args: ["/a.zip", "zipkit.json"] },
    ]);
    const event = { stage: "plan", level: "info", event: "plan.done" } as never;
    host.reply({ type: "event", id: 1, event });
    host.reply({ type: "done", id: 2, value: true });
    host.reply({ type: "done", id: 1, value: [{ path: "/a", kind: "file" }] });
    await expect(first).resolves.toEqual([{ path: "/a", kind: "file" }]);
    await expect(second).resolves.toBe(true);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("asks the host to cancel on abort and rebuilds its failure with the fields main reads", async () => {
    const host = fakeHost();
    const sdk = createSdkClient(() => host.process);
    const controller = new AbortController();
    const call = sdk.call("plan", [["/a"], {} as never], { signal: controller.signal });
    controller.abort();
    expect(host.sent.at(-1)).toEqual({ type: "cancel", id: 1 });
    host.reply({ type: "failed", id: 1, error: { name: "ZipKitError", message: "aborted", code: "operation.cancelled", kind: "cancelled", effect: "none" } });
    await expect(call).rejects.toMatchObject({ name: "ZipKitError", code: "operation.cancelled", kind: "cancelled", effect: "none" });
    await expect(sdk.call("verify", ["/x", "zipkit.json"], { signal: controller.signal })).rejects.toBeDefined();
  });

  it("hands a write's physical settlement over and resolves it when the host says so", async () => {
    const host = fakeHost();
    const sdk = createSdkClient(() => host.process);
    let settlement: Promise<void> | undefined;
    const call = sdk.call("write", [{} as never], { onPhysicalSettlement: (p) => { settlement = p; } });
    host.reply({ type: "physical", id: 1 });
    host.reply({ type: "done", id: 1, value: 10 });
    await expect(call).resolves.toBe(10);
    let settled = false;
    void settlement!.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.reply({ type: "physical-settled", id: 1 });
    await settlement;
  });

  it("fails every waiting call when the host ends, settles its physical work, and starts afresh", async () => {
    const hosts = [fakeHost(), fakeHost()];
    let spawned = 0;
    const sdk = createSdkClient(() => hosts[spawned++]!.process);
    let settlement: Promise<void> | undefined;
    const write = sdk.call("write", [{} as never], { onPhysicalSettlement: (p) => { settlement = p; } });
    hosts[0]!.reply({ type: "physical", id: 1 });
    const plan = sdk.call("plan", [["/a"], {} as never]);
    hosts[0]!.exit(134);
    await expect(write).rejects.toMatchObject({ code: "host.exited", kind: "unavailable", effect: "unknown" });
    await expect(plan).rejects.toMatchObject({ code: "host.exited" });
    await settlement;
    const again = sdk.call("verify", ["/a.zip", "zipkit.json"]);
    expect(spawned).toBe(2);
    hosts[1]!.reply({ type: "done", id: 3, value: true });
    await expect(again).resolves.toBe(true);
  });

  it("stops the host on request, failing what still waits", async () => {
    const host = fakeHost();
    const sdk = createSdkClient(() => host.process);
    const call = sdk.call("verify", ["/a.zip", "zipkit.json"]);
    sdk.stop();
    expect(host.process.killed).toBe(true);
    await expect(call).rejects.toMatchObject({ code: "host.exited" });
  });
});
