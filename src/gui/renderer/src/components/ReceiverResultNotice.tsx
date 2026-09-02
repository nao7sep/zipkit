import type { ReceiverResult, ReceiverResultDetails } from "../externalDropBoundary";
import { CloseIcon } from "./Icon";

export function ReceiverResultNotice({
  result,
  onDismiss,
}: {
  result: ReceiverResultDetails & Partial<Pick<ReceiverResult, "operationKey">>;
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
        aria-label="Close result"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
