import { z } from "zod";

const envSchema = z.object({
  ABLETON_OSC_HOST: z.string().default("127.0.0.1"),
  ABLETON_OSC_SEND_PORT: z.coerce.number().int().positive().default(11000),
  ABLETON_OSC_LISTEN_PORT: z.coerce.number().int().positive().default(11001),
  ABLETON_OSC_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  ABLETON_DRY_RUN: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (typeof v === "boolean") return v;
      return v === "1" || v.toLowerCase() === "true";
    })
    .default(false),
  ABLETON_REQUIRE_DESTRUCTIVE_CONFIRM: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (typeof v === "boolean") return v;
      const lowered = v.toLowerCase();
      return lowered !== "0" && lowered !== "false";
    })
    .default(true)
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
