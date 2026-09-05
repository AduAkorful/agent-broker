import { execSync } from "node:child_process";

const staged = execSync("git diff --cached --name-only -- .codex/").toString().trim();
if (staged) {
  console.error(".codex/ files are staged and must not be committed:");
  console.error(staged);
  console.error("\nUntrack with: git rm --cached <file>");
  process.exit(1);
}
