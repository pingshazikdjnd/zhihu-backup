import crypto from "node:crypto";

export function normalizeForHash(input: string) {
  return (input || "")
    .replace(/\sdata-pid="[^"]*"/g, "")
    .replace(/\sdata-original-token="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}
