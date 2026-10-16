/**
 * A job's state as plain text in the state's colour, shared by the queue
 * listbox row and the Archive pane header. Reaching a state takes the user no
 * effort, so it is a quiet label rather than a pill that asks to be watched.
 */

import type { CSSProperties } from "react";
import type { Job } from "../../../shared/api";
import { stateColor, stateLabel } from "../view";
import { useI18n } from "../i18n/I18nContext";

export function StateLabel({ state }: { state: Job["state"] }) {
  const { t } = useI18n();
  const style: CSSProperties = {
    color: stateColor(state),
    fontWeight: 600,
    fontSize: "0.8rem",
    whiteSpace: "nowrap",
    flexShrink: 0,
  };
  return <span style={style}>{t(stateLabel(state))}</span>;
}
