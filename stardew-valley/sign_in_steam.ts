// Sibling files are type imports only: each script is compiled standalone, so runtime imports of them wouldn't resolve.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ContextMount, HookContext, HookInputDeclaration } from "../_lib/hook_context";

// Signs the server in to Steam, which downloads the game and lets players join with an invite code.
//
// The steam-auth container runs `login` on its console when it has no saved session, then serves.
// `login` asks for the password of the account in STEAM_USERNAME, then for Steam Guard: approve in
// the Steam app, or type a code. This step types the password the owner gave into that console,
// reads what the console asks next, and asks the owner for anything Steam wants. The password is
// never written into the app's settings; the session Steam returns is kept in the app's
// steam-session folder.
//
// Docker's log can't say what the console is asking. The log gets a line when the line ends, and a
// prompt ("Steam Password: ", "Choice [1]: ") ends only once it is answered. So the password prompt
// is read from the line `login` writes just before it, and everything after from the console
// itself: this step attaches to the container before it types, which shows each prompt as written.

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
/** The line `login` writes straight before it asks for the password (SteamAuthService.cs). */
const ACCOUNT_LINE = /^Steam account: .+ \(from STEAM_USERNAME\)$/;

export type ConsoleState =
  | { kind: "password" }
  | { kind: "choice" }
  | { kind: "code"; retry: boolean }
  | { kind: "signedIn" }
  | { kind: "refused"; reason: string }
  | { kind: "waiting" };

/**
 * What the console is waiting for, from what it has written since this step last typed, as the
 * attached console shows it. A prompt counts only while it is the last thing written: one answered
 * already has more after it. Docker's log is no input for this: it never ends with a prompt.
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

/**
 * Whether the console is waiting for the password, from Docker's log. The prompt itself is not in
 * the log until it is answered, so this reads the line before it: `login` writes the account's
 * name and asks straight after, and anything it does later adds lines.
 */
export function asksForPassword(log: string): boolean {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return ACCOUNT_LINE.test(lines.at(-1) ?? "");
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

/** The lines the container has finished writing. A line still being written, a prompt, is not here. */
async function containerLog(id: string, socketPath: string): Promise<string> {
  const response = await fetch(`http://docker/containers/${id}/logs?stdout=1&stderr=1`, {
    unix: socketPath,
    signal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
  } as RequestInit);
  if (!response.ok) throw new Error(`Docker answered ${response.status} for the Steam container's log`);
  return response.text();
}

export interface LiveConsole {
  /** Everything the container has written since the console was opened. */
  text(): string;
  close(): void;
}

function headerEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

/**
 * Opens the container's console to read: Docker's attach, output only, which carries every byte as
 * the container writes it (the container has a TTY, so the stream has no frames). Resolves once
 * Docker has attached, so what is typed after that is answered where this can see it. Closing it
 * leaves the container's own console open.
 */
export function openConsole(id: string, socketPath: string = DOCKER_SOCKET): Promise<LiveConsole> {
  const request = new TextEncoder().encode(
    `POST /containers/${id}/attach?stream=1&stdout=1&stderr=1 HTTP/1.1\r\n` +
      "Host: docker\r\nContent-Length: 0\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
  );
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let head: Uint8Array = new Uint8Array(0);
    let attached = false;
    let sent = 0;
    let text = "";
    let end = () => {};
    // Rejects before it ends the socket: ending it calls `close`, which would name the wrong reason
    const refuse = (error: Error) => {
      clearTimeout(deadline);
      reject(error);
      end();
    };
    const deadline = setTimeout(
      () => refuse(new Error("Docker didn't open the Steam container's console in time")),
      DOCKER_TIMEOUT_MS,
    );
    const send = (socket: { write(data: Uint8Array): number }) => {
      while (sent < request.length) {
        const written = socket.write(request.subarray(sent));
        if (written <= 0) return;
        sent += written;
      }
    };
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          end = () => socket.end();
          send(socket);
        },
        drain(socket) {
          send(socket);
        },
        data(socket, chunk) {
          let bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (!attached) {
            head = new Uint8Array([...head, ...bytes]);
            const at = headerEnd(head);
            if (at < 0) return;
            const status = Number(new TextDecoder().decode(head.subarray(0, at)).split(" ")[1]);
            // 101 when the daemon honours the upgrade; an older one hijacks with a 200
            if (status !== 101 && status !== 200) {
              refuse(new Error(`Docker refused the Steam container's console (${status})`));
              return;
            }
            attached = true;
            clearTimeout(deadline);
            bytes = head.subarray(at + 4);
            resolve({ text: () => text, close: () => socket.end() });
          }
          text += decoder.decode(bytes, { stream: true });
        },
        close() {
          if (!attached) refuse(new Error("Docker closed the Steam container's console before it opened"));
        },
        error(_socket, error) {
          if (!attached) refuse(error);
        },
        connectError(_socket, error) {
          refuse(error);
        },
      },
    }).catch(refuse);
  });
}

const codeQuestion = (description: string, required: boolean): HookInputDeclaration[] => [
  {
    type: "question",
    id: "code",
    question: { question: "Steam Guard code", type: "text", key: "code", required, description },
  },
];

/** `dockerSocket` is the tests' way in: the platform calls this with the context alone. */
export async function run(ctx: HookContext, dockerSocket: string = DOCKER_SOCKET): Promise<void> {
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
  const asking = async () => !!container && asksForPassword(await containerLog(container.id, dockerSocket));
  let asked = await waitFor(ctx, 20_000, asking);
  if (!asked && ctx.restartApp) {
    ctx.log("The Steam container isn't asking for a password, so the app restarts to ask again.");
    await ctx.restartApp();
    container = await waitFor(ctx, START_WAIT_MS, steamContainer);
    asked = await waitFor(ctx, START_WAIT_MS, asking);
  }
  if (!container || !asked) {
    if (hasSession(folder)) return;
    ctx.fail("The Steam container didn't ask for a password. Try again in a minute.");
  }

  // Attached before the password is typed: what Steam asks next is only ever on the console.
  const live = await openConsole(container.id, dockerSocket);
  try {
    await answerSteam(ctx, live, folder, password);
  } finally {
    live.close();
  }
}

/** Types the password, then answers what the console asks until Steam signs the account in or refuses. */
async function answerSteam(ctx: HookContext, live: LiveConsole, folder: string, password: string): Promise<void> {
  let seen = 0;
  const read = async () => live.text().slice(seen);
  const type = async (text: string) => {
    seen = live.text().length;
    await ctx.writeAppStdin!(`${text}\r`, { service: SERVICE });
  };
  let state: ConsoleState;

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
