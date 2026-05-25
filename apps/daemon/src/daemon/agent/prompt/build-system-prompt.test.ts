import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from './build-system-prompt.js';

void test('buildSystemPrompt includes Phase 4 recovery guidance', () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /discovery -> read -> mutate/);
  assert.match(prompt, /versionToken with read_file/);
  assert.match(prompt, /conflict_stale_write/);
  assert.match(prompt, /returns not_found after rename\/move\/delete/);
  assert.match(
    prompt,
    /use write_file without a versionToken only for the new-file creation path/,
  );
  assert.match(prompt, /agent_spawn is depth-1 only/);
  assert.match(
    prompt,
    /multiple independent subtasks, issue multiple agent_spawn calls in the same round instead of serializing them one by one; agent_spawn always launches in parallel/,
  );
  assert.match(prompt, /call agent_wait explicitly/);
  assert.match(
    prompt,
    /use agent_send_input instead of spawning a fresh child/,
  );
  assert.match(prompt, /use agent_stop to cancel that specific child handle/);
  assert.match(prompt, /plain text results/);
  assert.match(prompt, /Plain text is the default final answer shape/);
  assert.match(
    prompt,
    /If you intentionally choose the temporary legacy artifact transport for preview/,
  );
  assert.match(
    prompt,
    /The runtime currently recognizes only <!-- GEULBAT_ARTIFACT/,
  );
  assert.match(
    prompt,
    /For renderer=react_bundle, the canonical runtime truth is a JSON manifest with exactly one string entryUrl/,
  );
  assert.match(
    prompt,
    /compat ingress input for renderer=react_bundle may also be a JSON object shaped like \{ "files": \{ \.\.\. \}, "entry": "src\/App\.jsx" \}/,
  );
  assert.match(
    prompt,
    /A bare JSON object such as \{"files": \{\.\.\.\}, "entry": "src\/main\.jsx"\} is plain text, not an artifact/,
  );
  assert.match(
    prompt,
    /Do not emit virtual project trees outside JSON, App\.jsx\/styles\.css prose blobs, or raw inline JSX\/TSX modules as the payload body/,
  );
  assert.match(
    prompt,
    /html5 or js artifacts are usually a better default than react_bundle/,
  );
  assert.match(
    prompt,
    /if the user explicitly asks for React, do not silently downgrade to html5 or js/,
  );
  assert.match(
    prompt,
    /Use react_bundle with either a valid entryUrl manifest or the bounded \{ "files": \{ \.\.\. \}, "entry": "\.\.\." \} compat input/,
  );
  assert.match(
    prompt,
    /Example react_bundle inline compat shape: <!-- GEULBAT_ARTIFACT \{"renderer":"react_bundle","digest":"demo-react-artifact-v1"\} -->/,
  );
  assert.match(
    prompt,
    /"files":\{"src\/main\.jsx":"import React from \\"react\\"; import \{ createRoot \} from \\"react-dom\/client\\";/,
  );
  assert.match(
    prompt,
    /Never wrap the temporary envelope in extra prose, headings, or commentary/,
  );
  assert.match(prompt, /temporary transport shape/);
  assert.match(prompt, /Do not call search_memory_index on every turn/);
  assert.match(prompt, /refresh_memory_index explicitly/);
  assert.match(prompt, /search_memory_index results are hints only/);
  assert.match(
    prompt,
    /When using list_files for the workspace root, omit path or use "\."\. Never send path as an empty string\./,
  );
});

void test('buildSystemPrompt includes author voice for adult fiction co-writing', () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /co-writer for the author's Korean fiction workspace/);
  assert.match(prompt, /intended for an adult readership/);
  assert.match(
    prompt,
    /dark, violent, morally complex, or sexually explicit content for adult fiction/,
  );
  assert.match(
    prompt,
    /explicit version of a scene is the canonical version when requested/,
  );
  assert.match(
    prompt,
    /tone applies consistently across chapters, side stories, and revisions/,
  );
  assert.match(
    prompt,
    /name the exact reason and ask the author for direction/,
  );
  assert.match(prompt, /출력은 작가의 원고 톤을 따른다/);
});
