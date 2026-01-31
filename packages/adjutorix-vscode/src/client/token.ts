import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const TOKEN_PATH = path.join(os.homedir(), ".adjutorix", "token");

export async function readAdjutorixToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf8");
    const token = raw.trim();
    return token.length ? token : null;
  } catch {
    return null;
  }
}
