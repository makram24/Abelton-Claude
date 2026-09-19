/** Normalize errors into stable codes for audit / health tools. */

export function classifyError(error) {
  const message = String(error?.message ?? error ?? "");
  if (message.includes("EADDRINUSE")) return "PORT_CONFLICT";
  if (message.includes("Timeout waiting for OSC response")) return "OSC_TIMEOUT";
  if (message.includes("Role") && message.includes("not allowed")) return "POLICY_BLOCKED";
  if (message.includes("Destructive action blocked")) return "DESTRUCTIVE_CONFIRM_REQUIRED";
  if (message.includes("Unknown or disallowed action")) return "PLAN_ACTION_UNKNOWN";
  return "UNKNOWN_ERROR";
}
