// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

// Signs the server in to Steam, which downloads the game and lets players join with an invite code.
//
// The steam-auth container runs `login` on its console when it has no saved session, then serves.
// `login` asks for the password of the account in STEAM_USERNAME, then for Steam Guard: approve in
// the Steam app, or type a code. This step types the password the owner gave into that console,
// reads what the console asks next from the container's log over the Docker socket, and asks the
// owner for anything Steam wants. The password is never written into the app's settings; the
// session Steam returns is kept in the app's steam-session folder.

const SERVICE = "steam-auth";
const SESSION_FOLDER = "/data/steam-session";
const DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 5000;
const POLL_MS = 1500;
/** How long the container gets to start and ask for the password. */
const START_WAIT_MS = 120_000;
/** How long Steam gets to answer after each thing typed, a phone approval included. */
const ANSWER_WAIT_MS = 180_000;

const PASSWORD_PROMPT = "Steam Password:";
const CHOICE_PROMPT = "Choice [1]:";
const CODE_PROMPT = "Enter Steam Guard code";
const SIGNED_IN = /Logged in (as|with saved session)/;
const REFUSED = /(Authentication failed|Login failed): ?(.*)/;

export type ConsoleState =
  | { kind: "password" }
  | { kind: "choice" }
  | { kind: "code"; retry: boolean }
  | { kind: "signedIn" }
  | { kind: "refused"; reason: string }
  | { kind: "waiting" };

/**
 * What the console is waiting for, from the log text written since this step last typed. A prompt
 * counts only while it is the last thing written: one answered already has more log after it.
 */
export function consoleState(text: string): ConsoleState {
  if (SIGNED_IN.test(text)) return { kind: "signedIn" };
  const refused = REFUSED.exec(text);
  if (refused) return { kind: "refused", reason: refused[2]?.trim() ?? "" };
  const tail = text.trimEnd();
  if (tail.endsWith(PASSWORD_PROMPT)) return { kind: "password" };
  if (tail.endsWith(CHOICE_PROMPT)) return { kind: "choice" };
  const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
  if (lastLine.includes(CODE_PROMPT) && lastLine.endsWith(":")) {
    return { kind: "code", retry: /Incorrect code/.test(text) };
  }
  return { kind: "waiting" };
}

/** Whether a saved Steam session is in the folder, at its top or under the account's name. */
export function hasSession(folder: string): boolean {
  if (existsSync(join(folder, "session.json"))) return true;
  try {
    return readdirSync(folder, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(folder, entry.name, "session.json")),
    );
  } catch {
    return false;
  }
}

function sessionFolder(mounts: ContextMount[]): string | null {
  return mounts.find((mount) => mount.containerPath === SESSION_FOLDER)?.localPath ?? null;
}

/** Everything the container has written, as it was typed at a terminal (the container has a TTY). */
async function containerLog(id: string): Promise<string> {
  const response = await fetch(`http://docker/containers/${id}/logs?stdout=1&stderr=1`, {
    unix: DOCKER_SOCKET,
    signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
  } as RequestInit);
  if (!response.ok) throw new Error(`Docker answered ${response.status} for the Steam container's log`);
  return response.text();
}

const codeQuestion = (description: string, required: boolean): HookInputDeclaration[] => [
  {
    type: "question",
    id: "code",
    question: { question: "Steam Guard code", type: "text", key: "code", required, description },
  },
];

export async function run(ctx: HookContext): Promise<void> {
  const folder = sessionFolder(ctx.mounts);
  if (!folder) ctx.fail("HexOS can't find this app's Steam session folder.");
  if (hasSession(folder)) {
    ctx.log("A Steam session is saved already, so there's nothing to sign in.");
    return;
  }
  if (!ctx.appContainers || !ctx.writeAppStdin || !ctx.askForInputs) {
    ctx.fail("Update this server to sign in to Steam from HexOS.");
  }
  const password = String(ctx.inputs.steam_password ?? "");
  if (!password) ctx.fail("Enter your Steam password to sign in.");

  const steamContainer = async () => (await ctx.appContainers!()).find((c) => c.service === SERVICE && c.state === "running");

  // The console asks for the password only once a run of `login` starts. A run that already
  // ended (a wrong password last time) is started again with the app.
  let container = await waitFor(ctx, START_WAIT_MS, steamContainer);
  let seen = 0;
  const read = async () => (container ? (await containerLog(container.id)).slice(seen) : "");
  let state = await waitForPrompt(ctx, read, 20_000);
  if (state.kind === "waiting" && ctx.restartApp) {
    ctx.log("The Steam container isn't asking for a password, so the app restarts to ask again.");
    await ctx.restartApp();
    container = await waitFor(ctx, START_WAIT_MS, steamContainer);
    seen = 0;
    state = await waitForPrompt(ctx, read, START_WAIT_MS);
  }
  if (!container || state.kind !== "password") {
    if (hasSession(folder)) return;
    ctx.fail("The Steam container didn't ask for a password. Try again in a minute.");
  }

  const type = async (text: string) => {
    seen = (await containerLog(container!.id)).length;
    await ctx.writeAppStdin!(`${text}\r`, { service: SERVICE });
  };

  await type(password);
  for (;;) {
    state = await waitForPrompt(ctx, read, ANSWER_WAIT_MS, () => hasSession(folder));
    if (state.kind === "signedIn" || hasSession(folder)) {
      ctx.log("Signed in to Steam. The server downloads the game now, which takes a few minutes.");
      return;
    }
    if (state.kind === "refused") {
      ctx.fail("Steam refused the sign-in. Check the username and password, then try again.", [
        { label: "Steam said", value: state.reason || "no reason" },
      ]);
    }
    if (state.kind === "choice") {
      const answers = await ctx.askForInputs(
        codeQuestion(
          "Approve the sign-in in the Steam app on your phone and leave this empty, or type the code the app shows.",
          false,
        ),
        { title: "Approve the sign-in in Steam" },
      );
      const code = String(answers.code ?? "").trim();
      if (!code) {
        await type("1");
        continue;
      }
      await type("2");
      const next = await waitForPrompt(ctx, read, 20_000);
      if (next.kind !== "code") ctx.fail("Steam didn't ask for the code. Try again.");
      await type(code);
      continue;
    }
    if (state.kind === "code") {
      const answers = await ctx.askForInputs(
        codeQuestion(
          state.retry
            ? "Steam didn't accept that code. Type the newest code Steam sent you."
            : "Type the code Steam sent to your email or shows in the Steam app.",
          true,
        ),
        { title: "Enter your Steam Guard code" },
      );
      await type(String(answers.code ?? "").trim());
      continue;
    }
    if (state.kind === "password") ctx.fail("Steam asked for the password again. Try again.");
    ctx.fail("Steam didn't answer in time. Try again in a minute.");
  }
}

async function waitFor<T>(ctx: HookContext, ms: number, find: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await find().catch(() => undefined);
    if (found || Date.now() > deadline) return found;
    await ctx.sleep(POLL_MS);
  }
}

async function waitForPrompt(
  ctx: HookContext,
  read: () => Promise<string>,
  ms: number,
  done: () => boolean = () => false,
): Promise<ConsoleState> {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = consoleState(await read().catch(() => ""));
    if (state.kind !== "waiting" || done() || Date.now() > deadline) return state;
    await ctx.sleep(POLL_MS);
  }
}
