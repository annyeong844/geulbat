import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from './build-system-prompt.js';

void test('buildSystemPrompt includes tool and mutation recovery guidance', () => {
  const prompt = buildSystemPrompt({
    profile: 'root',
    computerSessionAvailable: true,
    workingDirectory: 'home/user/chosen-start',
  });

  assert.match(prompt, /discovery -> read -> mutate/);
  assert.match(prompt, /versionToken with read_file/);
  assert.match(prompt, /conflict_stale_write/);
  assert.match(prompt, /returns not_found after rename\/move\/delete/);
  assert.match(
    prompt,
    /use write_file without a versionToken only for the new-file creation path/,
  );
  assert.match(
    prompt,
    /child agents may also spawn admitted helper agents when that is the right decomposition/,
  );
  assert.match(
    prompt,
    /multiple independent subtasks, issue multiple agent_spawn calls in the same round instead of serializing them one by one; agent_spawn always launches in parallel/,
  );
  assert.match(
    prompt,
    /broader inspection or verification workflows, make the phase and pending work visible/,
  );
  assert.match(
    prompt,
    /launch only the currently independent items as a same-round agent_spawn wave/,
  );
  assert.match(prompt, /Continue independent parent work while children run/);
  assert.match(prompt, /agent_wait defaults to an immediate progress snapshot/);
  assert.match(
    prompt,
    /explicit wait_mode all or any only at a dependency barrier/,
  );
  assert.match(prompt, /blocked children need explicit follow-up/);
  assert.match(
    prompt,
    /Do not invent a private workflow tool, hidden queue, or fixed wave-size policy/,
  );
  assert.match(prompt, /visible backpressure/);
  assert.match(prompt, /request a progress snapshot with agent_wait/);
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
  assert.match(prompt, /Do not read an entire file as reconnaissance/);
  assert.match(prompt, /explicit offset and the required limit/);
  assert.match(
    prompt,
    /continue from nextOffset only when more lines are needed/,
  );
  assert.match(
    prompt,
    /Use tool_search when you know the action but not the exact tool name/,
  );
  assert.match(prompt, /search hints are not callable aliases/);
  assert.match(prompt, /Use skill_search with invocation=implicit/);
  assert.match(
    prompt,
    /Use invocation=explicit only when the user explicitly requested that Skill/,
  );
  assert.match(prompt, /Treat an @skill_name mention.*explicit Skill request/);
  assert.match(prompt, /Normalize ASCII underscores to hyphens/);
  assert.match(prompt, /require an exact available Skill result/);
  assert.match(prompt, /read the complete SKILL\.md at instructionsRef/);
  assert.match(prompt, /read only the needed resources beneath skillRootRef/);
  assert.match(prompt, /Never auto-run a Skill script, MCP server, app, hook/);
  assert.match(
    prompt,
    /normal tool availability and approval rules still apply/,
  );
  assert.match(
    prompt,
    /allowImplicitInvocation=false may be followed only when the user explicitly requested that Skill/,
  );
  assert.match(prompt, /pinned read-only geulbat-sdk alias/);
  assert.match(
    prompt,
    /read only the needed geulbat-sdk signature with read_file/,
  );
  assert.match(prompt, /import the listed wrapper from the PTC exec tool/);
  assert.match(prompt, /Do not dump the full SDK tree/);
  assert.match(
    prompt,
    /Use fetch_url only when you already have an explicit public HTTP\(S\) URL/,
  );
  assert.match(prompt, /Prefer dedicated typed tools for file listing/);
  assert.match(prompt, /Do not use exec_command as an alias/);
  assert.match(
    prompt,
    /Use exec_command only when the user explicitly asks for a shell command/,
  );
  assert.doesNotMatch(prompt, /exec_command.*including familiar.*ls, cat, rg/u);
  assert.doesNotMatch(prompt, /execute_code/u);
  assert.doesNotMatch(prompt, /web_fetch/);
  assert.match(
    prompt,
    /Call list_files and search_files directly for routine file discovery/,
  );
  assert.match(
    prompt,
    /do not substitute exec_command for that file-tool path/,
  );
  assert.match(
    prompt,
    /rediscover the new path with the dedicated list_files or search_files tool/,
  );
  assert.doesNotMatch(prompt, /list_files\/search_files SDK wrappers/u);
});

void test('buildSystemPrompt describes a general agent and the actual host boundary', () => {
  const prompt = buildSystemPrompt({
    profile: 'root',
    computerSessionAvailable: true,
    workingDirectory: 'home/user/chosen-start',
  });

  assert.match(prompt, /general-purpose personal agent/);
  assert.match(
    prompt,
    /current working directory as path context only\. It is not a project, storage owner, or filesystem authority boundary/,
  );
  assert.match(
    prompt,
    /Follow the user's requested language and domain instead of assuming a fixed fiction, coding, or other specialist role/,
  );
  assert.match(prompt, /File tools use the host filesystem/);
  assert.match(prompt, /Relative paths start from the run working directory/);
  assert.match(
    prompt,
    /absolute paths and parent traversal are not confined to the Computer coordinate base/,
  );
  assert.match(prompt, /working directory is only a relative-path base/);
  assert.match(
    prompt,
    /does not restrict host-file visibility, own durable state, or create filesystem authority/,
  );
  assert.match(prompt, /may use any host cwd available to the daemon process/);
  assert.match(prompt, /Do not add another file-root selector/);
  assert.match(prompt, /user-selected run cwd is "home\/user\/chosen-start"/);
  assert.match(prompt, /through context compaction/);
  assert.match(
    prompt,
    /absolute host paths remain available independently of cwd/,
  );
  assert.doesNotMatch(prompt, /\bworkspace\b/u);
  assert.doesNotMatch(prompt, /root="(?:workspace|computer)"/);
  assert.doesNotMatch(prompt, /configured Computer root/);
  assert.match(
    prompt,
    /Windows drive path to its mounted drive path under WSL/,
  );
  assert.match(prompt, /discover and invoke a Windows PowerShell executable/);
  assert.match(prompt, /may invoke powershell\.exe or wsl\.exe when installed/);
  assert.doesNotMatch(prompt, /Korean-language novel workspace/);
  assert.doesNotMatch(prompt, /not a general assistant/);
  assert.doesNotMatch(prompt, /adult readership/);
});

void test('buildSystemPrompt gives subagents a compact role prompt and truthful computer capability', () => {
  const explorerPrompt = buildSystemPrompt({
    profile: 'explorer',
    computerSessionAvailable: false,
  });
  const workerPrompt = buildSystemPrompt({
    profile: 'worker',
    computerSessionAvailable: true,
  });

  assert.match(explorerPrompt, /explorer subagent/);
  assert.match(
    explorerPrompt,
    /Computer filesystem access is unavailable in this run/,
  );
  assert.match(
    explorerPrompt,
    /Do not retry file or host-command access through a hidden root fallback/,
  );
  assert.match(explorerPrompt, /report the unavailable capability honestly/);
  assert.doesNotMatch(explorerPrompt, /root="(?:workspace|computer)"/);
  assert.match(explorerPrompt, /list_files for directory discovery/);
  assert.match(explorerPrompt, /Do not read an entire file as reconnaissance/);
  assert.match(explorerPrompt, /explicit offset and the required limit/);
  assert.match(explorerPrompt, /Continue independent work after spawning/);
  assert.match(
    explorerPrompt,
    /explicit blocking wait_mode only when dependent/,
  );
  assert.match(explorerPrompt, /agent_stop on that child handle/);
  assert.doesNotMatch(explorerPrompt, /tool_search/);
  assert.doesNotMatch(explorerPrompt, /PTC exec tool/);
  assert.doesNotMatch(explorerPrompt, /GEULBAT_ARTIFACT/);
  assert.doesNotMatch(explorerPrompt, /react_bundle/);
  assert.match(workerPrompt, /worker subagent/);
  assert.match(workerPrompt, /discovery -> read -> mutate/);
  assert.match(workerPrompt, /File tools use the host filesystem/);
  assert.match(
    workerPrompt,
    /Relative paths start from the run working directory/,
  );
  assert.match(workerPrompt, /Do not add another file-root selector/);
  assert.doesNotMatch(workerPrompt, /root="(?:workspace|computer)"/);
  assert.match(workerPrompt, /dedicated list_files, read_file, search_files/);
  assert.match(workerPrompt, /Do not read an entire file as reconnaissance/);
  assert.match(workerPrompt, /explicit offset and the required limit/);
  assert.match(workerPrompt, /Continue independent work after spawning/);
  assert.match(workerPrompt, /explicit blocking wait_mode only when dependent/);
  assert.match(workerPrompt, /agent_stop on that child handle/);
  assert.doesNotMatch(workerPrompt, /tool_search/);
  assert.doesNotMatch(workerPrompt, /PTC exec tool/);
  assert.doesNotMatch(workerPrompt, /GEULBAT_ARTIFACT/);
});
