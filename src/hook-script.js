/** Replace only the owned block; preserve surrounding user bytes exactly. */
export function updateHookScript(existing, marker, snippet) {
  const endMarker = `# end ${marker.slice(2)}`;
  const starts = [...existing.matchAll(new RegExp(`^${marker}$`, "gm"))];
  if (starts.length === 0) {
    return `${existing}${existing.endsWith("\n") ? "\n" : "\n\n"}${snippet}`;
  }
  if (starts.length !== 1) throw new Error(`Ambiguous hook marker: ${marker}`);
  const start = starts[0].index;
  const tail = existing.slice(start);
  const ends = [...tail.matchAll(new RegExp(`^${endMarker}$`, "gm"))];
  let length;
  if (ends.length === 1) {
    length = ends[0].index + endMarker.length;
    if (tail[length] === "\n") length++;
  } else if (ends.length > 1) {
    throw new Error(`Ambiguous hook end marker: ${marker}`);
  } else {
    // Persisted hooks predate end markers. Recognize released snippets exactly;
    // never infer a shell block boundary from arbitrary user code.
    const legacy = snippet.slice(0, snippet.indexOf(endMarker));
    const withoutPath = legacy.replace(/^export PATH=.*\n/m, "");
    const oldPath = 'export PATH="$PWD/.venv/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n';
    const candidates = [legacy, withoutPath, withoutPath.replace(`${marker}\n`, `${marker}\n${oldPath}`)];
    const variants = candidates.flatMap((body) => [
      body,
      body.replaceAll("hook run --staged", "hook run"),
      body.replaceAll("|| true", "&"),
    ]);
    const matched = variants.find((body) => tail.startsWith(body));
    if (!matched) throw new Error(`Unrecognized legacy hook; original file preserved: ${marker}`);
    length = matched.length;
  }
  return existing.slice(0, start) + snippet + tail.slice(length);
}
