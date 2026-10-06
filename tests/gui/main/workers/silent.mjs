// A managed-write thread that never answers, as a stalled disk would leave it.
setInterval(() => {}, 1_000);
