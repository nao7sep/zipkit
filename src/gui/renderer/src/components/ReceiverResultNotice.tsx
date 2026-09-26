import type { ReceiverResult, ReceiverResultDetails } from "../externalDropBoundary";
import { CloseIcon } from "./Icon";
import { useI18n } from "../i18n/I18nContext";

export function ReceiverResultNotice({
  result,
  onDismiss,
}: {
  result: ReceiverResultDetails & Partial<Pick<ReceiverResult, "operationKey">>;
  onDismiss: () => void;
}) {
  const { t, text } = useI18n();
  return (
    <div
      role={result.severity === "error" ? "alert" : "status"}
      aria-atomic="true"
      className={`receiver-result receiver-result--${result.severity}`}
    >
      <span>{text(result.message)}</span>
      <button
        type="button"
        className="icon receiver-result__dismiss"
        onClick={onDismiss}
        aria-label={t("result.close")}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
