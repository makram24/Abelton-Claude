import { z } from "zod";

function toBool(v, defaultValue) {
  if (typeof v === "boolean") return v;
  if (v === undefined || v === null || v === "") return defaultValue;
  const lowered = String(v).toLowerCase();
  if (lowered === "1" || lowered === "true") return true;
  if (lowered === "0" || lowered === "false") return false;
  return defaultValue;
}

const envSchema = z.object({
  ABLETON_OSC_HOST: z.string().default("127.0.0.1"),
  ABLETON_OSC_SEND_PORT: z.coerce.number().int().positive().default(11000),
  ABLETON_OSC_LISTEN_PORT: z.coerce.number().int().positive().default(11001),
  ABLETON_OSC_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  ABLETON_DRY_RUN: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => toBool(v, false))
    .default(false),
  ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => toBool(v, true))
    .default(true),
  /** Heuristic / planner tools. Off by default for an honest core surface. */
  ABLETON_ENABLE_SCAFFOLD_TOOLS: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => toBool(v, false))
    .default(false),
  /** observer | operator | admin — default operator (writes ok, destructive gated). */
  ABLETON_DEFAULT_ROLE: z.enum(["observer", "operator", "admin"]).default("operator")
});

export function getConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment config: ${errors}`);
  }

  return parsed.data;
}
