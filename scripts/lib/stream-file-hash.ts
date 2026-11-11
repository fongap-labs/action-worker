import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Stream asset hashing without loading release payloads into memory. */
export async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}
