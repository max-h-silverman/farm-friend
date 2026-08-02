import { spawn } from "node:child_process";
import { hashAdminPassword } from "../lib/admin-password";

const SECRET_ID = "farm-friend-admin-password-hash";
const DEFAULT_PROJECT = "farm-friend-vashon";

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("A private interactive terminal is required");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function addSecretVersion(project: string, verifier: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "gcloud",
      ["secrets", "versions", "add", SECRET_ID, "--project", project, "--data-file=-"],
      { stdio: ["pipe", "inherit", "inherit"], shell: false },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Secret Manager rejected the new verifier version"));
    });
    child.stdin.end(verifier);
  });
}

async function main(): Promise<void> {
  const password = await readHidden("New administrator password: ");
  const confirmation = await readHidden("Confirm administrator password: ");
  if (password !== confirmation) throw new Error("Passwords do not match");

  const verifier = await hashAdminPassword(password);
  await addSecretVersion(process.env.GCP_PROJECT ?? DEFAULT_PROJECT, verifier);
  process.stdout.write("Administrator password verifier stored. Redeploy before testing it.\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Provisioning failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
