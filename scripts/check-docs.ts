import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function documentationOnly(paths: string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        /\.md$/i.test(path) ||
        path === "LICENSE" ||
        /^docs\/.+\.(?:png|jpe?g|gif|svg|webp|avif)$/i.test(path),
    )
  );
}

function withoutCode(source: string, inline = true): string {
  let fence: string | undefined;
  return source
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return "";
      }
      return fence ? "" : inline ? line.replace(/`+[^`]*`+/g, "") : line;
    })
    .join("\n");
}

function anchors(source: string): Set<string> {
  const found = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of withoutCode(source, false).split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line)?.[1];
    if (!heading) continue;
    const slug = heading
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    found.add(count ? `${slug}-${count}` : slug);
  }
  return found;
}

function targets(source: string): string[] {
  const result: string[] = [];
  for (const match of source.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm))
    result.push(match[1] ?? match[2]!);
  const start = /!?\[[^\]\n]*\]\(/g;
  for (const match of source.matchAll(start)) {
    let cursor = match.index! + match[0].length;
    if (source[cursor] === "<") {
      const end = source.indexOf(">", cursor + 1);
      if (end >= 0) result.push(source.slice(cursor + 1, end));
      continue;
    }
    const beginning = cursor;
    let depth = 1;
    while (cursor < source.length && depth) {
      const character = source[cursor]!;
      if (character === "\\") cursor++;
      else if (character === "(") depth++;
      else if (character === ")") depth--;
      else if (/\s/.test(character) && depth === 1) break;
      if (depth) cursor++;
    }
    if (cursor > beginning) result.push(source.slice(beginning, cursor));
  }
  return result;
}

/** Check repository paths and Markdown heading fragments; remote links are not fetched. */
export function checkDocumentation(root: string, files: string[]): string[] {
  const errors: string[] = [];
  const headings = new Map<string, Set<string>>();
  for (const file of files.filter((path) => extname(path).toLowerCase() === ".md")) {
    const source = readFileSync(resolve(root, file), "utf8");
    for (const target of targets(withoutCode(source))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      const [path, fragment] = target.split("#", 2);
      let resolved: string;
      try {
        resolved = resolve(
          root,
          dirname(file),
          decodeURIComponent(path || "") || file.split(/[\\/]/).at(-1)!,
        );
      } catch {
        errors.push(`${file}: invalid local link ${target}`);
        continue;
      }
      const inside = relative(root, resolved);
      if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
        errors.push(`${file}: link leaves repository: ${target}`);
        continue;
      }
      if (!existsSync(resolved)) errors.push(`${file}: missing local target ${target}`);
      else if (fragment && extname(resolved).toLowerCase() === ".md") {
        if (!headings.has(resolved))
          headings.set(resolved, anchors(readFileSync(resolved, "utf8")));
        let anchor: string;
        try {
          anchor = decodeURIComponent(fragment);
        } catch {
          errors.push(`${file}: invalid fragment ${target}`);
          continue;
        }
        if (!headings.get(resolved)!.has(anchor)) errors.push(`${file}: missing heading ${target}`);
      }
    }
  }
  return errors;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
}
function main() {
  if (process.argv.includes("--scope")) {
    let full = true;
    if (process.env.FORCE_FULL !== "true" && process.env.GITHUB_EVENT_PATH) {
      try {
        const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) as {
          before?: string;
          after?: string;
          pull_request?: { base: { sha: string }; head: { sha: string } };
        };
        const before = event.pull_request?.base.sha ?? event.before;
        const after = event.pull_request?.head.sha ?? event.after;
        if (
          before &&
          after &&
          /^[a-f0-9]{40}$/.test(before) &&
          !/^0+$/.test(before) &&
          /^[a-f0-9]{40}$/.test(after)
        ) {
          const changed = git(["diff", "--name-only", before, after])
            .split(/\r?\n/)
            .filter(Boolean);
          full = !documentationOnly(changed);
        }
      } catch {
        // Unknown bases and event shapes require full verification.
      }
    }
    assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required for scope selection");
    appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
    console.log(full ? "Full verification selected" : "Documentation-only verification selected");
    return;
  }
  const errors = checkDocumentation(
    process.cwd(),
    git(["ls-files", "*.md"]).split(/\r?\n/).filter(Boolean),
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS: tracked Markdown local paths and heading links are valid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
