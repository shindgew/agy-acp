// Global test setup: point AGY_ACP_STATE_DIR at a throwaway directory so
// SessionStore never touches the real developer machine's ~/.agy-acp-state.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll } from "vitest";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-state-"));
  process.env.AGY_ACP_STATE_DIR = dir;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
