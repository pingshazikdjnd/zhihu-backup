export function normalizeForHash(input: string) {
  return (input || "")
    .replace(/\sdata-pid="[^"]*"/g, "")
    .replace(/\sdata-original-token="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function sha256(input: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}
