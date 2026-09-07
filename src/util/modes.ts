/** File and directory permissions for the things this tool writes outside the repository.
 *
 * Two consumers now — the config file and the metadata cache — which is why this is not still a
 * private corner of `src/setup/config_file.ts`. Importing `src/setup/` from `src/cache/` would
 * invert the layering: `setup` is a command, and these modes are infrastructure.
 */

/** Owner-only, on both counts. The directory needs `x` to be traversed at all; the file does not,
 * and an execute bit on a YAML document or a JSON cache entry would say something untrue about it. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Windows has no POSIX modes, and `Deno.chmod` refuses there. It also needs none: everything
 * under %APPDATA% already inherits an ACL granting only that user, SYSTEM and Administrators. */
export const POSIX = Deno.build.os !== 'windows';

/** Applies the intended mode to something that already exists. Creating with `mode` covers the
 * new-file case; this covers a file or directory made before, or by hand. */
export const repairMode = async (path: string, mode: number): Promise<void> => {
  if (!POSIX) return;
  try {
    const info = await Deno.stat(path);
    if (((info.mode ?? mode) & 0o777) !== mode) await Deno.chmod(path, mode);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
};
