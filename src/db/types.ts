import type { ErrorDetails, PermissionInfo, TaskDetails } from "./columns.js";
import type { StepPayload } from "./step-payload.js";

export type { StepPayload } from "./step-payload.js";

/** A row from the `steps` table of an agy conversation SQLite database. */
export type StepRow = {
  idx: number;
  stepType: number;
  /**
   * agy step status enum (from the `status` column):
   *   2 = in progress, 3 = completed, 6 = cancelled/aborted, 7 = failed.
   * Mapped to ACP tool_call status by `toolCallStatus` in updates/utils.
   */
  status: number;
  stepPayload: StepPayload;
  /** Decoded `error_details` column, when the step carries an error. */
  error?: ErrorDetails | null;
  /** Decoded `permissions` column, when the step requested a permission. */
  permission?: PermissionInfo | null;
  /** Decoded `task_details` column, for background-task steps. */
  task?: TaskDetails | null;
};
