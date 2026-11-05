import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function snapshotPath(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { kind: "missing" };
  if (stat.isSymbolicLink()) return { kind: "symlink", target: fs.readlinkSync(file) };
  if (stat.isFile()) return { kind: "file", mode: stat.mode, content: fs.readFileSync(file) };
  throw new Error(`TDD cannot snapshot a non-file implementation path: ${file}`);
}

export function readHeadPath(root, relative) {
  const options = { cwd: root, timeout: 5000, maxBuffer: 50 * 1024 * 1024 };
  const entry = spawnSync("git", ["ls-tree", "-z", "HEAD", "--", `:(literal)${relative}`], options);
  if (entry.status !== 0) throw new Error(`Cannot read HEAD entry: ${relative}`);
  if (!entry.stdout.length) return { kind: "missing" };
  const mode = entry.stdout.toString().slice(0, 6);
  if (!["100644", "100755", "120000"].includes(mode)) {
    throw new Error(`Unsupported HEAD file type: ${relative}`);
  }
  const blob = spawnSync("git", ["show", `HEAD:${relative}`], options);
  if (blob.status !== 0) throw new Error(`Cannot read HEAD content: ${relative}`);
  return mode === "120000"
    ? { kind: "symlink", target: blob.stdout.toString() }
    : { kind: "file", mode: Number.parseInt(mode, 8), content: blob.stdout };
}

/** Unlink the directory entry first: never write through a symlink. */
export function restorePath(file, state) {
  const current = fs.lstatSync(file, { throwIfNoEntry: false });
  if (current) {
    if (!current.isFile() && !current.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-file implementation path: ${file}`);
    }
    fs.unlinkSync(file);
  }
  if (state.kind === "missing") return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (state.kind === "symlink") fs.symlinkSync(state.target, file);
  else {
    fs.writeFileSync(file, state.content, { mode: state.mode });
    fs.chmodSync(file, state.mode);
  }
}
