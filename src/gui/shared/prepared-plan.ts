import type { PlanSummary } from "zipkitsdk/types";

/** GUI reference to a host-owned plan. It is invalid after host replacement. */
export interface PreparedPlan {
  revision: string;
  output: string;
  writable: boolean;
  summary: PlanSummary;
  scanIncomplete: boolean;
  reviewChanged: boolean;
}
