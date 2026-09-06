/** Running other programs, shared by the release scripts.
 *
 * `git` captures output and is for asking questions; `run` inherits the streams and is for the
 * long-running steps whose progress the user should see. Both throw on failure, so a script reads
 * as a straight line and a broken step stops the release rather than half-finishing it. */

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export const git = async (...args: string[]): Promise<string> => {
  const { stdout, stderr, success } = await new Deno.Command('git', { args }).output();
  if (!success) throw new Error(`git ${args.join(' ')} failed: ${decode(stderr)}`);
  return decode(stdout).trim();
};

/** Runs a command with its output on the terminal. Returns false rather than throwing when
 * `tolerant` is set — used for the "does this exist yet?" probes. */
export const run = async (cmd: string, ...args: string[]): Promise<void> => {
  const { success } = await new Deno.Command(cmd, { args, stdout: 'inherit', stderr: 'inherit' })
    .output();
  if (!success) throw new Error(`${cmd} ${args.join(' ')} failed`);
};

/** Whether a command succeeded, with its output swallowed. For probing state, never for doing
 * work: a failure here is an answer, not an error. */
export const succeeds = async (cmd: string, ...args: string[]): Promise<boolean> => {
  const { success } = await new Deno.Command(cmd, {
    args,
    stdout: 'null',
    stderr: 'null',
  }).output();
  return success;
};

/** What a command printed, or `null` when it failed. The sibling of `succeeds` for the probes
 * whose answer is the output rather than the exit status — `npm view pkg@version version` exits 0
 * with *empty* stdout for a package that exists without that version, so "did it succeed?" is the
 * wrong question and would read a missing version as a published one. */
export const output = async (cmd: string, ...args: string[]): Promise<string | null> => {
  const { stdout, success } = await new Deno.Command(cmd, { args, stderr: 'null' }).output();
  return success ? decode(stdout).trim() : null;
};
