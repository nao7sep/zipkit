import type { ReceiverResult } from "../externalDropBoundary";
import { CloseIcon } from "./Icon";

export function ReceiverResultNotice({
  result,
  onDismiss,
}: {
  result: ReceiverResult;
  onDismiss: () => void;
}) {
  return (
    <div
      role={result.severity === "error" ? "alert" : "status"}
      aria-atomic="true"
      className={`receiver-result receiver-result--${result.severity}`}
    >
      <span>{result.message}</span>
      <button
        type="button"
        className="icon receiver-result__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss result"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
