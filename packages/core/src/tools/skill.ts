/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { ToolResult, ToolResultDisplay } from './tools.js';
import type { Content } from '@google/genai';
import type {
  Config,
  ModelInvocableCommandExecutorResult,
} from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig } from '../skills/types.js';
import {
  logSkillLaunch,
  recordSkillInvocation,
  SkillLaunchEvent,
} from '../telemetry/index.js';
import path from 'path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { recordAutoSkillUsage } from '../skills/skill-curator.js';

const debugLogger = createDebugLogger('SKILL');

export interface SkillParams {
  skill: string;
  args?: string;
}

// Re-export for backward compatibility
export { buildSkillLlmContent } from './skill-utils.js';
import {
  buildSkillLlmContent,
  applySkillSideEffects,
  ReviewWorkflowActivationError,
  collectAvailableSkillEntries,
  clearCollectedSkillEntriesCache,
  canApplySkillSideEffects,
  skillModelInvocationBlock,
} from './skill-utils.js';

/**
 * Static description for the Skill tool. The live list of available skills is
 * deliberately NOT embedded here — it is injected as an `<available_skills>`
 * `<system-reminder>` in the startup prelude (see `environmentContext`) and
 * refreshed via per-turn deltas. Keeping this description constant for the whole
 * session means skill changes never mutate the tools block, which sits at the
 * front of the tools → system → messages prompt-cache prefix. Mirrors Claude
 * Code's static SkillTool prompt ("Available skills are listed in
 * system-reminder messages in the conversation").
 */
const SKILL_TOOL_DESCRIPTION = `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to invoke:
- Use this tool with the skill name only (no arguments)
- Name the skill exactly as it appears in the available-skills listing; do not shorten or guess a spelling.
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "xlsx"\` - invoke the xlsx skill
  - \`skill: "ms-office-suite:pdf"\` - invoke the pdf skill owned by the ms-office-suite extension
  - \`skill: "mcp-prompt", args: "topic"\` - invoke a model-invocable command with arguments

Important:
- Available skills are listed in <system-reminder> messages in the conversation; only use skills listed there.
- A skill provided by an extension is registered as \`<extensionName>:<skillName>\` (e.g. \`ms-office-suite:pdf\`), so two extensions offering the same authored name are two different skills. Personal, project, and bundled skills keep the single name their author wrote and are never prefixed.
- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action
- NEVER just announce or mention a skill in your text response without actually calling this tool
- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- When executing scripts or loading referenced files, ALWAYS resolve absolute paths from skill's base directory. Examples:
  - \`bash scripts/init.sh\` -> \`bash /path/to/skill/scripts/init.sh\`
  - \`python scripts/helper.py\` -> \`python /path/to/skill/scripts/helper.py\`
  - \`reference.md\` -> \`/path/to/skill/reference.md\`
</skills_instructions>`;

/**
 * The route that actually re-arms a skill resume declined, named per reason.
 * "Re-invoke the skill" is the wrong advice for most of them: the model route
 * is refused by the very condition that produced the decline. The slash
 * command checks only enabledness, so it still re-arms an inactive or
 * model-hidden skill; for a disabled one it is filtered out of the registry
 * too, and no route exists until the skill is re-enabled.
 *
 * Each remedy takes the `SkillConfig`, not just the name, because
 * `user-invocable: false` removes the slash route entirely: the command is
 * registered with `userInvocable: false` and then dropped by every
 * dispatch-facing accessor (`CommandService.getCommandsForMode`), the
 * `/skills` picker included, so `Unknown command` is all the operator would
 * get. Naming `/<skill-name>` there would leave them with nothing at all,
 * since the same message says the model route is refused. The flag is tested
 * with `=== false`, matching `SkillCommandLoader`'s `?? true` default: only
 * an explicit `false` loses the route.
 */
const SKILL_RESTORE_REMEDIES = {
  reinvoke: () => 're-invoke the skill to re-apply its hooks and allowedTools',
  // `paths:` activation is what the model route waits on, and it needs no
  // slash command: touching a matching file fires it, after which a model
  // re-invocation re-applies the side effects.
  activate: (skill: SkillConfig) =>
    skill.userInvocable === false
      ? 'access a file matching its `paths:` so the activation fires and the model can invoke it again — it declares `user-invocable: false`, so there is no slash command for it'
      : `run /${skill.name} to re-apply its hooks and allowedTools — re-invoking it as a tool is refused while the activation has not fired`,
  unhide: (skill: SkillConfig) =>
    skill.userInvocable === false
      ? 'no route re-arms it while it declares both `disable-model-invocation` and `user-invocable: false` — remove one of them'
      : `run /${skill.name} to re-apply its hooks and allowedTools — re-invoking it as a tool is refused while \`disable-model-invocation\` is set`,
  // `/skills` is not a route for a `user-invocable: false` skill: the picker
  // filters those out before building its toggleable list.
  enable: (skill: SkillConfig) =>
    skill.userInvocable === false
      ? 'remove it from skills.disabled and then re-invoke it — while it is disabled no route re-arms it, and it declares `user-invocable: false`, so it is neither listed in /skills nor has a slash command'
      : `re-enable it via /skills (or remove it from skills.disabled) and then run /${skill.name} to re-apply its hooks and allowedTools — while it is disabled no route re-arms it, the slash command included`,
} as const;

type SkillRestoreRemedy = keyof typeof SKILL_RESTORE_REMEDIES;

/**
 * What resume tells the operator when it declines to re-arm a skill, keyed by
 * the condition `skillModelInvocationBlock` reports. The phrasing is the
 * whole point of the branch — a gate that vanishes in silence is #11180 — so
 * each reason names what changed since the skill was invoked, not merely that
 * something did, and each carries the route that actually works.
 */
const SKILL_RESTORE_DECLINED_REASONS: Record<
  'disabled' | 'inactive' | 'hidden',
  { reason: string; remedy: SkillRestoreRemedy }
> = {
  // `skills.disabled`, or its extension deactivated. Both live paths refuse a
  // disabled skill before applying anything, so restoring its allow rules and
  // hooks would switch an auto-approval back on after the user turned it off.
  disabled: { reason: 'it is disabled', remedy: 'enable' },
  // `paths:` activation is in-memory, so a conditional skill starts a resumed
  // session deactivated and `validateToolParams` refuses it in that state.
  inactive: {
    reason: 'its `paths:` activation has not fired',
    remedy: 'activate',
  },
  // `disable-model-invocation: true`, which `execute` refuses outright
  // (`Skill "X" not found.`): re-arming it would grant a session what no tool
  // call can ask for.
  hidden: { reason: 'it is hidden from model invocation', remedy: 'unhide' },
};

/**
 * Whether a recorded Skill tool response is one of the strings `execute()`
 * returns in place of a body: the dedup confirmation and its refusals. Each
 * embeds the name exactly as requested, so the match is anchored on it at
 * position 0 and a body that merely quotes one of these phrases is not
 * mistaken for it. Validation refusals never reach here — the scheduler
 * records those under `error`, not `output`.
 */
function isSkillNonBodyResponse(
  requestedName: string,
  output: string,
): boolean {
  const subject = `Skill "${requestedName}"`;
  return (
    output.startsWith(`${subject} is already loaded in context.`) ||
    output.startsWith(`${subject} is disabled.`) ||
    output.startsWith(`${subject} not found.`) ||
    output.startsWith(`Failed to load skill "${requestedName}": `)
  );
}

/**
 * Skill tool that enables the model to access skill definitions. The tool keeps
 * an in-memory set of the currently available skills (for validation) but exposes
 * a static description to the model — the live listing reaches the model via the
 * startup-prelude snapshot and per-turn `<system-reminder>` deltas.
 */
export class SkillTool extends BaseDeclarativeTool<SkillParams, ToolResult> {
  static readonly Name: string = ToolNames.SKILL;

  private skillManager: SkillManager;
  private availableSkills: SkillConfig[] = [];
  // Conditional skills (with `paths:`) that exist on disk but have not yet
  // been activated by a matching tool invocation. Tracked separately so
  // validateToolParams can give a distinct error message when the model
  // names one of these: "gated by paths:, access a matching file first"
  // instead of the generic "not found".
  private pendingConditionalSkillNames: Set<string> = new Set();
  private modelInvocableCommands: ReadonlyArray<{
    name: string;
    description: string;
  }> = [];
  private hiddenSkillNames: Set<string> = new Set();
  private loadedSkillNames: Set<string> = new Set();
  private loadedSkillContents: Set<string> = new Set();
  // Cleanup function returned by `addChangeListener`. Stored so per-agent
  // SkillTool instances (subagents share the parent's SkillManager) can
  // detach their listener at teardown — without this the SkillManager
  // accumulates listeners across subagent lifetimes, and each path
  // activation would serialize through every stale listener's refreshSkills run.
  private removeChangeListener: () => void;

  constructor(private readonly config: Config) {
    // Initialize with a basic schema first
    const initialSchema = {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The skill or command name. E.g., "pdf" or "xlsx"',
        },
        args: {
          type: 'string',
          description: 'Optional arguments for model-invocable slash commands.',
        },
      },
      required: ['skill'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    super(
      SkillTool.Name,
      ToolDisplayNames.SKILL,
      SKILL_TOOL_DESCRIPTION, // Static; live skill list is injected via system-reminders.
      Kind.Read,
      initialSchema,
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );

    const skillManager = config.getSkillManager();
    if (!skillManager) {
      throw new Error('SkillManager not available');
    }
    this.skillManager = skillManager;
    // Await-able so SkillManager.notifyChangeListeners can sequence on it:
    // matchAndActivateByPaths must not resolve until the runtime sets reflect
    // the newly activated skill, otherwise validateToolParams could reject a
    // skill that the same-turn <system-reminder> just announced as available.
    // (refreshSkills now only updates in-memory sets; it no longer mutates the
    // tool declaration or calls setTools — see SKILL_TOOL_DESCRIPTION.)
    this.removeChangeListener = this.skillManager.addChangeListener((options) =>
      this.refreshSkills(options),
    );

    // Populate the runtime sets asynchronously.
    this.refreshSkills();
  }

  /**
   * Refreshes the in-memory runtime sets — `availableSkills`,
   * `pendingConditionalSkillNames`, `modelInvocableCommands` — that back
   * `validateToolParams` / `execute`. Invoked on construction and whenever the
   * SkillManager fires a change (skill-file edit, conditional activation, config
   * toggle, or MCP-prompt provider change).
   *
   * It deliberately does NOT mutate the tool declaration or call
   * `llmClient.setTools()`. The Skill tool's description is static
   * (`SKILL_TOOL_DESCRIPTION`), so the skill set no longer affects the tools
   * block — and the tools block is the front of the tools → system → messages
   * prompt-cache prefix, where any byte change invalidates the whole cached
   * prefix. These runtime sets are in-memory only and never serialized into a
   * request, so refreshing them is prompt-cache-neutral. The model's view of the
   * available skills comes from the `<available_skills>` snapshot in the startup
   * prelude plus per-turn `<system-reminder>` deltas.
   */
  async refreshSkills(options?: { throwOnError?: boolean }): Promise<void> {
    try {
      // Invalidate the memoization cache so this refresh picks up any
      // skill-set mutations (file edits, conditional activations, config
      // toggles) that occurred since the last collection.
      clearCollectedSkillEntriesCache(this.skillManager);
      const collected = await collectAvailableSkillEntries(
        this.skillManager,
        this.config,
      );
      this.availableSkills = collected.availableSkills;
      this.pendingConditionalSkillNames =
        collected.pendingConditionalSkillNames;
      this.modelInvocableCommands = collected.modelInvocableCommands;
      this.hiddenSkillNames = collected.hiddenSkillNames ?? new Set();
    } catch (error) {
      debugLogger.warn('Failed to load skills for Skills tool:', error);
      this.availableSkills = [];
      this.pendingConditionalSkillNames = new Set();
      this.modelInvocableCommands = [];
      this.hiddenSkillNames = new Set();
      if (options?.throwOnError) throw error;
    }
  }

  override validateToolParams(params: SkillParams): string | null {
    // Validate required fields
    if (
      !params.skill ||
      typeof params.skill !== 'string' ||
      params.skill.trim() === ''
    ) {
      return 'Parameter "skill" must be a non-empty string.';
    }
    if (params.args !== undefined && typeof params.args !== 'string') {
      return 'Parameter "args" must be a string when provided.';
    }

    // Check file-based skills
    const skillExists = this.availableSkills.some(
      (skill) =>
        skill.name === params.skill && this.config.isSkillEnabled(skill),
    );
    if (skillExists) return null;

    // Check model-invocable commands (e.g. MCP prompts) listed in
    // <available_skills>. Consults the live provider — not just the cached
    // snapshot — because in interactive mode the provider is only attached
    // after CommandService initialisation resolves, which races SkillTool
    // construction: the constructor's refreshSkills() then reads a still-null
    // provider and caches an empty command set that is never refreshed unless
    // an unrelated SkillManager change event happens to fire (issue #9821).
    const commandExists = this.getModelInvocableCommands().some(
      (cmd) => cmd.name === params.skill,
    );
    if (commandExists) return null;

    // Disabled-by-user branch — placed AFTER commandExists so a same-named
    // MCP prompt or file command can still pass validation. With the
    // `fileBasedSkillNames` exclusion in `refreshSkills`, a disabled skill
    // no longer shadows a same-named non-skill command, and we don't want
    // this branch to block the legitimate command path.
    const knownSkill = this.skillManager
      .getCachedSkills()
      ?.find((skill) => skill.name === params.skill);
    if (
      this.config.getDisabledSkillNames().has(params.skill.toLowerCase()) ||
      (knownSkill && !this.config.isSkillEnabled(knownSkill))
    ) {
      return `Skill "${params.skill}" is disabled. Re-enable it via /skills or remove it from skills.disabled.`;
    }

    // Distinct error for a conditional skill (registered via `paths:`
    // frontmatter) that has not yet been activated by a matching tool call.
    // Without this branch the model can't tell the difference between "no
    // such skill exists" and "exists but you need to access a matching file
    // to unlock it."
    if (this.pendingConditionalSkillNames.has(params.skill)) {
      return `Skill "${params.skill}" is gated by path-based activation (paths: frontmatter) and is not yet available. Access a file matching its paths patterns first to activate it.`;
    }

    const availableNames = [
      ...new Set([
        ...this.availableSkills.map((s) => s.name),
        ...this.getModelInvocableCommands().map((c) => c.name),
      ]),
    ];
    if (availableNames.length === 0) {
      return `Skill "${params.skill}" not found. No skills are currently available.`;
    }
    return `Skill "${params.skill}" not found. Available skills: ${availableNames.join(', ')}`;
  }

  /**
   * Returns the model-invocable commands to validate against, preferring a
   * live read of the config provider over the cached snapshot from the last
   * `refreshSkills()` (see `validateToolParams` for the late-attach race).
   * Falls back to the cache when no provider is registered (e.g. SDK mode)
   * or when the provider throws. The provider is synchronous, so the live
   * read is cheap enough to run on every validation.
   *
   * Commands whose names collide with a file-based skill (active or pending
   * path-activation) are dropped, mirroring the `fileBasedSkillNames` dedup
   * in `collectAvailableSkillEntries` — without this, a command named after
   * a path-gated skill would pass validation here and bypass the
   * "gated by paths:" branch above.
   */
  private getModelInvocableCommands(): ReadonlyArray<{
    name: string;
    description: string;
  }> {
    let commands: ReadonlyArray<{ name: string; description: string }>;
    const provider = this.config.getModelInvocableCommandsProvider();
    if (provider) {
      try {
        commands = provider();
      } catch (error) {
        debugLogger.warn(
          'Model-invocable commands provider threw; falling back to cached set:',
          error,
        );
        commands = this.modelInvocableCommands;
      }
    } else {
      commands = this.modelInvocableCommands;
    }
    const knownSkills = this.skillManager.getCachedSkills() ?? [];
    const shadowedNames = new Set<string>([
      ...this.availableSkills
        .filter((skill) => this.config.isSkillEnabled(skill))
        .map((skill) => skill.name),
      ...Array.from(this.pendingConditionalSkillNames).filter((name) => {
        const skill = knownSkills.find((candidate) => candidate.name === name);
        return !skill || this.config.isSkillEnabled(skill);
      }),
    ]);
    return commands.filter((cmd) => !shadowedNames.has(cmd.name));
  }

  protected createInvocation(params: SkillParams) {
    return new SkillToolInvocation(
      this.config,
      this.skillManager,
      params,
      (name: string, content?: string) => {
        this.loadedSkillNames.add(name);
        if (content !== undefined) this.loadedSkillContents.add(content);
      },
      this.config.getModelInvocableCommandsExecutor(),
      (name: string) => this.loadedSkillNames.has(name),
      (name: string) => this.hiddenSkillNames.has(name),
    );
  }

  override toAutoClassifierInput(params: SkillParams): Record<string, unknown> {
    return params.args === undefined
      ? { skill: params.skill }
      : { skill: params.skill, args: params.args };
  }

  getAvailableSkillNames(): string[] {
    return this.availableSkills.map((skill) => skill.name);
  }

  /**
   * Returns the set of skill names that have been successfully loaded
   * (invoked) during the current session. Used by /context to attribute
   * loaded skill body tokens separately from the tool-definition cost.
   */
  getLoadedSkillNames(): ReadonlySet<string> {
    return this.loadedSkillNames;
  }

  getLoadedSkillContents(): ReadonlySet<string> {
    return this.loadedSkillContents;
  }

  async restoreLoadedSkillsFromHistory(history: Content[]): Promise<void> {
    this.clearLoadedSkills();

    // Restore is keyed off the committed skill cache. `getCachedSkills()`
    // returning `null` means specifically "no refresh has committed yet", not
    // "scanned and empty", so it must not be read as an empty cache: that
    // would decline every skill in the history, gate included — #11180 again,
    // quieter. Today `Config.initializeOnce` awaits the skill cache before it
    // constructs the tool registry and initializes the client, so no resume
    // reaches this line cold; the guard is what keeps that an ordering detail
    // of startup rather than a precondition this method silently depends on.
    // A warm cache makes it a no-op; only a genuinely cold one pays a scan.
    let cachedSkills = this.skillManager.getCachedSkills();
    if (cachedSkills === null) {
      try {
        await this.skillManager.listSkills();
        cachedSkills = this.skillManager.getCachedSkills();
      } catch (error) {
        debugLogger.warn(
          'Failed to load skills while restoring a resumed session; ' +
            'skills carried by the history will not be re-armed:',
          error,
        );
      }
    }

    // Exact names, the way the live path resolves a skill
    // (`findSkillByNameAtLevel` compares `skill.name === name`). A case-folded
    // key would collapse `deploy` and `Deploy` — both legal, and both kept by
    // `collectCachedSkills` — into whichever sorts last, binding a recorded
    // invocation to the other skill's side effects.
    const skillByName = new Map<
      string,
      { name: string; output: string; config: SkillConfig }
    >();
    for (const skill of cachedSkills ?? []) {
      const output = buildSkillLlmContent(
        path.dirname(skill.filePath),
        skill.body,
      );
      skillByName.set(skill.name, { name: skill.name, output, config: skill });
    }
    // Pre-rename transcripts request the authored spelling; fall back to it
    // only where no skill owns that name outright, or a resumed session
    // misses the restore and re-injects a body on the next invocation.
    for (const skill of cachedSkills ?? []) {
      const authored = (skill.authoredName ?? '').trim();
      if (authored && authored !== skill.name && !skillByName.has(authored)) {
        skillByName.set(authored, skillByName.get(skill.name)!);
      }
    }

    // Declines are collected and logged after the scan, not inline. The loop
    // walks history pairs, and a skill's first recorded pair can be a refusal
    // (or a body from a stale path) while a later pair is the real body that
    // restores and fully re-arms it — logging inline would warn that a gate
    // is gone about a gate this same loop then arms, and name a remedy the
    // dedup guard refuses.
    const declined = new Map<
      string,
      { skill: SkillConfig; reason: string; remedy: SkillRestoreRemedy | null }
    >();
    const restored: SkillConfig[] = [];

    const restoreSkill = (requestedName: unknown, output: unknown): void => {
      if (typeof requestedName !== 'string' || typeof output !== 'string') {
        return;
      }
      const skill = skillByName.get(requestedName);
      if (!skill) {
        // The skill was invoked in the recorded session but no longer
        // exists on disk (deleted, renamed, or its level disabled).
        debugLogger.debug(
          `Skill "${requestedName}" appears in the resumed history but is not in the current skill cache; not restoring it.`,
        );
        return;
      }
      if (this.loadedSkillNames.has(skill.name)) {
        // An earlier pair in this same history already restored this skill.
        // What follows is a same-session re-invocation, whose recorded
        // output is the dedup message rather than a body — matching it
        // against the file would blame `SKILL.md` for a skill that is
        // already armed. Nothing left to do for it either way.
        return;
      }
      if (output !== skill.output && !output.startsWith(`${skill.output}\n`)) {
        // The recorded output is not the body on disk now, so it cannot be
        // attributed to the current file: neither the dedup bookkeeping nor
        // the side effects are restored. This branch used to be a bare
        // `continue`; the silence is part of what made #11180 present as a
        // working setup.
        const entry = this.classifyUnmatchedSkillRecord(
          requestedName,
          output,
          skill.config,
        );
        // Rank, not last-write-wins. A skill invoked twice records a body
        // and then the dedup message; if the body pair already mismatched,
        // a later `remedy: null` pair would overwrite the one entry that
        // reports a genuinely lost gate, downgrading its `warn` to `debug`
        // and discarding the only actionable route. A refusal still wins
        // when it is the only thing recorded for that skill.
        const previous = declined.get(skill.name);
        const outranked =
          previous !== undefined &&
          previous.remedy !== null &&
          entry.remedy === null;
        if (!outranked) {
          declined.set(skill.name, entry);
        }
        return;
      }

      // Bookkeeping is unconditional: the body is in the restored context
      // regardless, and the dedup guard must know about it.
      this.loadedSkillContents.add(skill.output);
      this.loadedSkillNames.add(skill.name);
      restored.push(skill.config);
    };

    const pendingSkillCalls = new Map<string, string>();
    const pendingExecCalls = new Set<string>();
    for (const content of history) {
      for (const part of content.parts ?? []) {
        const call = part.functionCall;
        if (call?.name === ToolNames.EXEC && typeof call.id === 'string') {
          pendingExecCalls.add(call.id);
        }
        const requestedSkill = call?.args?.['skill'];
        if (
          call?.name === ToolNames.SKILL &&
          typeof call.id === 'string' &&
          typeof requestedSkill === 'string'
        ) {
          pendingSkillCalls.set(call.id, requestedSkill);
          continue;
        }

        const response = part.functionResponse;
        const output = response?.response?.['output'];
        if (
          response?.name === ToolNames.EXEC &&
          typeof response.id === 'string' &&
          pendingExecCalls.delete(response.id) &&
          typeof output === 'string'
        ) {
          let payload: unknown;
          try {
            payload = JSON.parse(output.split('\n', 1)[0]);
          } catch {
            continue;
          }
          if (
            !payload ||
            typeof payload !== 'object' ||
            !('toolResults' in payload) ||
            !Array.isArray(payload.toolResults)
          ) {
            continue;
          }
          const results: unknown[] = payload.toolResults;
          for (const result of results) {
            if (
              result &&
              typeof result === 'object' &&
              'name' in result &&
              result.name === ToolNames.SKILL &&
              'args' in result &&
              result.args &&
              typeof result.args === 'object' &&
              'skill' in result.args &&
              'output' in result
            ) {
              restoreSkill(result.args.skill, result.output);
            }
          }
          continue;
        }
        if (
          response?.name !== ToolNames.SKILL ||
          typeof response.id !== 'string' ||
          typeof output !== 'string'
        ) {
          continue;
        }

        const requestedName = pendingSkillCalls.get(response.id);
        pendingSkillCalls.delete(response.id);
        if (requestedName === undefined) continue;
        restoreSkill(requestedName, output);
      }
    }

    // Awaited before this method resolves, and the client awaits this method
    // before the resumed session takes a turn: a grant or hook registration
    // still in flight when the first post-resume tool call is evaluated would
    // reopen the window #11180 is about.
    for (const skill of restored) {
      await this.restoreSkillSideEffects(skill);
    }

    // Only for skills nothing later in the history restored. A decline the
    // loop went on to overturn is not a missing gate, and saying it is turns
    // the one signal #11180 asked for into noise that contradicts the loop's
    // own outcome. Declines raised by `restoreSkillSideEffects` are not
    // routed through here: those follow a successful body match, so no later
    // pair can overturn them.
    for (const [name, entry] of declined) {
      if (this.loadedSkillNames.has(name)) continue;
      this.logSkillNotRestored(entry.skill, entry.reason, entry.remedy);
    }
  }

  /**
   * Says why a recorded response that is not the body on disk now was
   * declined, and whether anything was lost with it.
   *
   * The default is the cautious reading: a record is treated as a body that
   * cannot be corroborated unless it is one of the strings `execute()` emits
   * *instead* of a body (`isSkillNonBodyResponse`). The shapes a real body
   * can be recorded in are owned by other modules and open to growth — the
   * truncation wrapper, the `<persisted-output>` stub, the spill-failure
   * fallback — while the set of non-body strings is small and closed.
   * Enumerating the wrappers instead would file every future one under "no
   * body was ever injected", at `debug`, for a skill whose side effects
   * `execute()` did apply. Getting a non-body string wrong in this direction
   * costs a spurious `warn`, never a silently lost gate.
   *
   * An uncorroborated body is still not re-armed: re-arming would grant
   * whatever the *current* frontmatter declares on the strength of a record
   * that cannot be compared against it.
   *
   * The compared string embeds the skill's base directory and a shared
   * boilerplate line as well as the body, so a body can also differ because
   * the skill directory now resolves elsewhere (a moved checkout, a symlinked
   * home, a session recorded inside the sandbox and resumed on the host).
   *
   * The remedy is not `reinvoke` unconditionally: a block condition can
   * co-exist with a mismatch, and then re-invoking is refused by
   * `validateToolParams` rather than by anything the mismatch caused. The
   * co-occurrence is not exotic — a moved checkout mismatches every skill,
   * and `paths:` activation is in-memory, so a conditional skill is
   * `inactive` by construction in a resumed process. Read live off `Config` /
   * `SkillManager`, the same way `restoreSkillSideEffects` reads it, never
   * off `SkillTool`'s async-committed snapshots.
   */
  private classifyUnmatchedSkillRecord(
    requestedName: string,
    output: string,
    skill: SkillConfig,
  ): { skill: SkillConfig; reason: string; remedy: SkillRestoreRemedy | null } {
    if (isSkillNonBodyResponse(requestedName, output)) {
      return {
        skill,
        reason: "the recorded tool response is not this skill's body",
        remedy: null,
      };
    }
    const blocked = skillModelInvocationBlock(
      this.config,
      this.skillManager,
      skill,
    );
    return {
      skill,
      reason:
        'its recorded body does not match SKILL.md on disk (the file ' +
        'changed, its skill directory now resolves to a different path, or ' +
        'the body was truncated or saved to a file for the model)',
      remedy: blocked
        ? SKILL_RESTORE_DECLINED_REASONS[blocked].remedy
        : 'reinvoke',
    };
  }

  /**
   * Re-applies a restored skill's side effects — `allowedTools` session allow
   * rules and frontmatter `hooks:` — so a resumed session enforces the same
   * rules the replayed conversation still instructs the model to follow.
   *
   * Both live in `PermissionManager` / `SessionHooksManager` as in-memory,
   * per-process state, so a resumed session starts with none of them while
   * the restored history still carries the skill's instructions. Nothing
   * re-arms them on its own: the dedup guard answers "already loaded in
   * context", so the model has no reason to re-invoke the skill. That is how
   * a skill's `PreToolUse` gate silently stopped firing after `--continue`
   * (#11180) — the fail-open shape #11067 closed on the slash-command path,
   * displaced onto resume.
   *
   * Both registrations dedup and the folder-trust gate is re-applied inside
   * `applySkillSideEffects`, so this is idempotent and a project skill in an
   * untrusted folder still gets nothing.
   *
   * A skill the model could not invoke today is skipped, so resume never
   * re-arms something a fresh tool call would refuse. The conditions are not
   * restated here: `skillModelInvocationBlock` is the same predicate the
   * availability filter uses to decide what the model may call, so the two
   * cannot drift into disagreeing about what a resumed session may hold.
   * That is deliberately the stricter of the two live paths — the
   * `/<skill-name>` loader checks only enabledness and would arm an inactive
   * or model-hidden skill — because this history records model tool calls,
   * and a user who wants the looser grant back can still type the slash
   * command.
   */
  private async restoreSkillSideEffects(skill: SkillConfig): Promise<void> {
    // One predicate, shared with the availability filter that decides what the
    // model may call (`skillModelInvocationBlock`), rather than a second copy
    // of its three conditions here. All three can change between sessions, and
    // one of them changes invisibly: frontmatter is not part of the recorded
    // body, so adding `disable-model-invocation: true` leaves the recorded
    // output byte-identical and the mismatch check still passes.
    //
    // Hooks are refused alongside the `allowedTools` grant, rather than split
    // off as "a gate is a restriction, so re-arming it is always safe". A
    // `PreToolUse` hook is not purely a restriction: it runs an arbitrary
    // command and its output can carry `permissionDecision: 'allow'` (and
    // `updatedPermissions`), so restoring one for a skill this session has not
    // activated can widen permissions as easily as narrow them — and it would
    // leave the hook armed for the whole session while the `paths:` scope that
    // was supposed to bound it never fired.
    const blocked = skillModelInvocationBlock(
      this.config,
      this.skillManager,
      skill,
    );
    if (blocked) {
      const { reason, remedy } = SKILL_RESTORE_DECLINED_REASONS[blocked];
      this.logSkillNotRestored(skill, reason, remedy);
      return;
    }
    try {
      await applySkillSideEffects(this.config, skill);
    } catch (error) {
      // Same tolerance as the live dedup path: the allow rules and hooks are
      // registered before the review workflow activation that failed, and a
      // failed activation must not abort the rest of the resume.
      if (!(error instanceof ReviewWorkflowActivationError)) throw error;
      debugLogger.warn(
        `Review workflow activation failed while restoring skill "${skill.name}" on resume; workflow dispatch may be unavailable:`,
        error,
      );
    }
  }

  /**
   * Says why a skill carried by the resumed history was not re-armed, and how
   * to get it back.
   *
   * `warn` when the skill declares a side effect this session is now missing
   * — `hooks:` or `allowedTools` — because that is what the operator needs to
   * know while the skill's instructions are still in context. Both halves
   * count: nine bundled skills declare `allowedTools` and none declares
   * `hooks:`, so keying the level on hooks alone would leave every one of
   * them declining at `debug`, under a message that says the lost half is
   * "hooks and allowedTools".
   *
   * What the level buys is grep and triage *inside the debug log*, not
   * operator visibility: `createDebugLogger`'s `warn` and `debug` share one
   * sink with no level threshold — `writeLog` returns early unless
   * `QWEN_DEBUG_LOG_FILE` is set (which `--debug` sets) and then appends
   * whatever it is given — so at default verbosity neither level is written
   * and with the file enabled both are. The improvement these lines make is
   * that these paths previously logged nothing at any level; surfacing a
   * missing gate to an operator who did not pass `--debug` is the part of
   * #11180 still open, and promoting a message from `debug` to `warn` does
   * not close it.
   *
   * A `null` remedy means the recorded response is one `execute()` emits in
   * place of a body, so that record carries nothing to re-arm. That is
   * `debug` regardless of what the skill declares.
   *
   * A project skill in an untrusted folder has no working route until trust
   * is granted — `applySkillSideEffects` refuses it on every path, the slash
   * command included — so the remedy leads with that precondition, checked
   * with the same predicate the enforcement path uses.
   */
  private logSkillNotRestored(
    skill: SkillConfig,
    reason: string,
    remedy: SkillRestoreRemedy | null,
  ): void {
    const head = `Not restoring skill "${skill.name}" on resume: ${reason}.`;
    if (remedy === null) {
      debugLogger.debug(
        `${head} That response carries no body for it, so there is ` +
          `nothing to re-arm from it.`,
      );
      return;
    }
    const route = SKILL_RESTORE_REMEDIES[remedy](skill);
    const message =
      `${head} Its instructions may still be in the replayed conversation; ` +
      (canApplySkillSideEffects(skill, this.config)
        ? `${route}.`
        : `until this folder is trusted nothing re-arms a project skill's ` +
          `hooks or allowedTools, the slash command included; once it is, ` +
          `${route}.`);
    // Emptiness, not truthiness, exactly as `applySkillHooks` tests it: `{}`
    // is truthy, and the parser assigns one for `hooks: {}` and for a block
    // whose event names are all unknown. Such a skill promised no gate, so a
    // warn here would be the same phantom failure that guard exists to avoid.
    const declaresLostSideEffect =
      (skill.hooks && Object.keys(skill.hooks).length > 0) ||
      (skill.allowedTools?.length ?? 0) > 0;
    if (declaresLostSideEffect) {
      debugLogger.warn(message);
    } else {
      debugLogger.debug(message);
    }
  }

  /**
   * Clears the loaded-skills tracking. Called when the session is reset
   * (e.g. /clear) and conservatively at destructive history-rewrite
   * boundaries (compaction, truncation, orphan stripping), so a skill
   * whose body was evicted never stays stuck behind the dedup guard.
   */
  clearLoadedSkills(): void {
    this.loadedSkillNames.clear();
    this.loadedSkillContents.clear();
  }

  /**
   * Detach the change listener from SkillManager. Tool registries call
   * this on teardown (mirroring AgentTool's pattern). Per-subagent
   * SkillTool instances share the parent's SkillManager via
   * `InProcessBackend.createPerAgentConfig`, so without dispose the
   * SkillManager would accumulate one stale listener per subagent
   * lifetime — and `notifyChangeListeners` is now `await`-ed
   * sequentially, so each path activation would serialize through every
   * accumulated listener's refreshSkills run.
   */
  dispose(): void {
    this.removeChangeListener();
  }
}

class SkillToolInvocation extends BaseToolInvocation<SkillParams, ToolResult> {
  // Populated by scheduler via setPromptId; empty = direct/non-scheduled
  // call, filter `prompt_id != ''` downstream. See design doc §4.1.1.
  private promptId = '';

  constructor(
    private readonly config: Config,
    private readonly skillManager: SkillManager,
    params: SkillParams,
    private readonly onSkillLoaded: (name: string, content?: string) => void,
    private readonly commandExecutor:
      | ((
          name: string,
          args?: string,
        ) => Promise<ModelInvocableCommandExecutorResult | null>)
      | null = null,
    private readonly isSkillLoaded: (name: string) => boolean = () => false,
    private readonly isSkillHidden: (name: string) => boolean = () => false,
  ) {
    super(params);
  }

  setPromptId(promptId: string): void {
    this.promptId = promptId;
  }

  getDescription(): string {
    return this.params.args === undefined
      ? `Use skill: "${this.params.skill}"`
      : `Use skill: "${this.params.skill}" with args: "${formatArgsForDescription(this.params.args)}"`;
  }

  /**
   * Skills load user-defined code that runs with the agent's tool
   * access — they're a privileged sink. In AUTO mode the classifier
   * needs to inspect the skill name and any inline args before the
   * skill loads, but the scheduler short-circuits at L4 when
   * `finalPermission === 'allow'`. The L3 default must be `'ask'` so
   * the classifier projection added in this PR can be reached.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  /**
   * Apply the skill's side effects — `allowedTools` session allow rules and
   * frontmatter hooks — when the folder-trust gate allows it. Idempotent:
   * both underlying registrations dedup already-applied entries.
   *
   * The gate has two sides. This is the way in; a project skill's grants
   * are additionally marked trust-gated, and both the permission manager
   * and the hook event handler re-read `isTrustedFolder()` at decision
   * time, so a trust revoked mid-session (an IDE trust notification flips it
   * live) suspends the already-applied hooks and allow rules without a
   * restart, and a trust granted again restores them.
   */
  private async applySideEffects(skill: SkillConfig): Promise<void> {
    await applySkillSideEffects(this.config, skill);
  }

  private async recordAutoSkillUsageBestEffort(
    skill: SkillConfig,
  ): Promise<void> {
    try {
      await recordAutoSkillUsage(this.config.getProjectRoot(), skill);
    } catch (error) {
      debugLogger.warn(
        `Failed to record auto-skill usage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeDisabledSkill(): Promise<ToolResult> {
    let disabledCommandFallbackAttempted = false;
    if (this.commandExecutor) {
      disabledCommandFallbackAttempted = true;
      // Wrap in try/catch matching the non-disabled path's graceful
      // degradation: if the MCP server throws
      // (network error, timeout, protocol violation), fall through to
      // the disabled-error message instead of propagating an unhandled
      // rejection out of execute(). Without this, disabling a skill
      // makes the system MORE fragile to MCP failures, not less.
      try {
        const content = await this.commandExecutor(
          this.params.skill,
          this.params.args ?? '',
        );
        if (content && typeof content === 'object' && 'error' in content) {
          return {
            llmContent: content.error,
            returnDisplay: content.error,
          };
        }
        if (typeof content === 'string') {
          // Delegated to a same-named non-skill command (file command
          // or MCP prompt). Don't emit `SkillLaunchEvent` and don't
          // track via `onSkillLoaded` — no skill body was loaded, and
          // conflating the two would inflate skill telemetry /
          // `/context` skill-token attribution with command runs.
          return {
            llmContent: [{ text: content }],
            returnDisplay: `Delegated to command: ${this.params.skill}`,
          };
        }
      } catch {
        // Fall through to the disabled-error message below.
      }
    }
    logSkillLaunch(
      this.config,
      new SkillLaunchEvent(this.params.skill, false, this.promptId),
    );
    if (!disabledCommandFallbackAttempted) {
      recordSkillInvocation(this.config, {
        skillName: this.params.skill,
        success: false,
      });
    }
    const msg = `Skill "${this.params.skill}" is disabled. Re-enable it via /skills or remove it from skills.disabled.`;
    return { llmContent: msg, returnDisplay: msg };
  }

  async execute(
    _signal?: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    if (this.isSkillHidden(this.params.skill)) {
      let hiddenCommandFallbackAttempted = false;
      if (this.commandExecutor) {
        hiddenCommandFallbackAttempted = true;
        try {
          const content = await this.commandExecutor(
            this.params.skill,
            this.params.args ?? '',
          );
          if (content && typeof content === 'object' && 'error' in content) {
            return {
              llmContent: content.error,
              returnDisplay: content.error,
            };
          }
          if (typeof content === 'string') {
            return {
              llmContent: [{ text: content }],
              returnDisplay: `Delegated to command: ${this.params.skill}`,
            };
          }
        } catch (error) {
          debugLogger.warn(
            `Hidden-skill command fallback failed for "${this.params.skill}":`,
            error,
          );
          // Fall through to the generic not-found message.
        }
      }
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, false, this.promptId),
      );
      if (!hiddenCommandFallbackAttempted) {
        recordSkillInvocation(this.config, {
          skillName: this.params.skill,
          success: false,
        });
      }
      const msg = `Skill "${this.params.skill}" not found.`;
      return { llmContent: msg, returnDisplay: msg };
    }

    // Disabled-skill guard. Mirrors validateToolParams's commandExists →
    // disabled ordering at the execution layer: when a skill is disabled
    // but a same-named non-skill command (MCP prompt, file command)
    // exists, we MUST run the command instead of loading the disabled
    // skill from disk. `loadSkillForRuntime` resolves by name and ignores
    // the `skills.disabled` setting, so without this guard a disabled
    // skill would still execute its body whenever it shadows a real
    // command.
    const disabled = this.config
      .getDisabledSkillNames()
      .has(this.params.skill.toLowerCase());
    if (disabled) {
      return this.executeDisabledSkill();
    }

    let commandFallbackAttempted = false;

    try {
      // Load the skill with runtime config (includes additional files)
      const skill = await this.skillManager.loadSkillForRuntime(
        this.params.skill,
      );
      if (skill && !this.config.isSkillEnabled(skill)) {
        return this.executeDisabledSkill();
      }

      if (!skill) {
        // Try model-invocable command executor (e.g. MCP prompts)
        if (this.commandExecutor) {
          commandFallbackAttempted = true;
          const commandResult = await this.commandExecutor(
            this.params.skill,
            this.params.args ?? '',
          );
          if (
            commandResult &&
            typeof commandResult === 'object' &&
            'error' in commandResult
          ) {
            logSkillLaunch(
              this.config,
              new SkillLaunchEvent(this.params.skill, false, this.promptId),
            );
            return {
              llmContent: commandResult.error,
              returnDisplay: commandResult.error,
            };
          }
          if (typeof commandResult === 'string') {
            logSkillLaunch(
              this.config,
              new SkillLaunchEvent(this.params.skill, true, this.promptId),
            );
            // Don't track via `onSkillLoaded` (mirrors the disabled
            // branch above): the result is raw command text, not a
            // skill body, so a tracked name here would block a later
            // same-named file skill behind the dedup guard even though
            // no body is resident.
            return {
              llmContent: [{ text: commandResult }],
              returnDisplay: `Executed command: ${this.params.skill}`,
            };
          }
        }

        // Log failed skill launch
        logSkillLaunch(
          this.config,
          new SkillLaunchEvent(this.params.skill, false, this.promptId),
        );
        if (!commandFallbackAttempted) {
          recordSkillInvocation(this.config, {
            skillName: this.params.skill,
            success: false,
          });
        }

        // Get parse errors if any
        const parseErrors = this.skillManager.getParseErrors();
        const errorMessages: string[] = [];

        for (const [filePath, error] of parseErrors) {
          if (filePath.includes(this.params.skill)) {
            errorMessages.push(`Parse error at ${filePath}: ${error.message}`);
          }
        }

        const errorDetail =
          errorMessages.length > 0
            ? `\nErrors:\n${errorMessages.join('\n')}`
            : '';

        return {
          llmContent: `Skill "${this.params.skill}" not found.${errorDetail}`,
          returnDisplay: `Skill "${this.params.skill}" not found.${errorDetail}`,
        };
      }

      // Log successful skill launch
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, true, this.promptId),
      );

      // Re-evaluated on every invocation, not just the first load: folder
      // trust can be granted mid-session (IDE trust notifications flip it
      // live), and a project skill first invoked while untrusted must not
      // stay side-effect-less for the rest of the session. Both grants
      // dedup, so re-applying is idempotent.
      let activationWarning = '';
      try {
        await this.applySideEffects(skill);
      } catch (error) {
        if (
          !(error instanceof ReviewWorkflowActivationError) ||
          !this.isSkillLoaded(this.params.skill)
        ) {
          throw error;
        }
        activationWarning = ` Warning: review workflow activation failed (${error.message}); workflow dispatch may be unavailable.`;
      }

      // Prevent re-invoking an already-loaded skill from appending
      // duplicate instructions to context. The first invocation
      // returns the full skill body; subsequent invocations return a
      // short confirmation so the model knows the skill is active
      // without wasting context tokens. Check BEFORE calling
      // onSkillLoaded, which adds the name to the loaded set.
      if (this.isSkillLoaded(this.params.skill)) {
        this.onSkillLoaded(this.params.skill);
        void this.recordAutoSkillUsageBestEffort(skill);
        const msg = `Skill "${this.params.skill}" is already loaded in context.${activationWarning}`;
        return {
          llmContent: msg,
          returnDisplay: msg,
        };
      }

      const baseDir = path.dirname(skill.filePath);
      const llmContent = buildSkillLlmContent(baseDir, skill.body);
      this.onSkillLoaded(this.params.skill, llmContent);

      void this.recordAutoSkillUsageBestEffort(skill);
      recordSkillInvocation(this.config, {
        skillName: this.params.skill,
        success: true,
      });

      return {
        llmContent: [{ text: llmContent }],
        returnDisplay: skill.description,
        modelOverride: skill.model,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(`[SkillsTool] Error using skill: ${errorMessage}`);

      // Log failed skill launch
      logSkillLaunch(
        this.config,
        new SkillLaunchEvent(this.params.skill, false, this.promptId),
      );
      if (!commandFallbackAttempted) {
        recordSkillInvocation(this.config, {
          skillName: this.params.skill,
          success: false,
        });
      }

      return {
        llmContent: `Failed to load skill "${this.params.skill}": ${errorMessage}`,
        returnDisplay: `Failed to load skill "${this.params.skill}": ${errorMessage}`,
      };
    }
  }
}

function formatArgsForDescription(args: string): string {
  const escapeMarkdown = (value: string) =>
    value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
  return args.length > 120
    ? `${escapeMarkdown(args.slice(0, 117))}...`
    : escapeMarkdown(args);
}
