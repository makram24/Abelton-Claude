/** Pure OSC message value extraction. */

export function parseOscValue(msg, fallback = null) {
  if (!msg?.args || msg.args.length === 0) return fallback;
  if (msg.args.length === 1) return msg.args[0]?.value ?? fallback;
  return msg.args.map((arg) => arg?.value);
}
