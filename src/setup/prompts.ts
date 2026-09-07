/** The only module in the tree that imports `@cliffy/prompt`.
 *
 * Everything above it passes plain data — a message, a list of `{ value, name }` — and gets a typed
 * answer back. That keeps the library in one file, so the decision to use it is one file's worth of
 * commitment, and it keeps the untestable surface as small as the menus can make it.
 *
 * **Ctrl+C never returns here.** Cliffy's key handler calls `Deno.exit(130)` from inside the
 * prompt, so no `finally` in this file or above it runs, and `run`'s exit-code contract is
 * bypassed. Raw mode without `cbreak` also suppresses `ISIG`, so no `SIGINT` arrives either. That
 * is why `tui.ts` writes credentials the moment they verify rather than accumulating every answer
 * and saving once at the end. Terminal sanity is cliffy's doing — it drops raw mode after every
 * read and shows the cursor in a `finally` of its own — so nothing here tries to help.
 */

import { Checkbox, Confirm, Input, Secret, Select } from '@cliffy/prompt';

/** One selectable thing. `value` is what comes back, `name` is what is read. */
export type Choice<T> = {
  value: T;
  name: string;
  checked?: boolean;
  disabled?: boolean;
};

/** A rule between groups of choices. Cliffy spells one as an option carrying only a name. */
export type Separator = { separator: string };

export type Item<T> = Choice<T> | Separator;

const RULE = '─'.repeat(34);

const isSeparator = <T>(item: Item<T>): item is Separator =>
  typeof (item as Separator).separator === 'string';

/** A plain rule, so callers do not have to know how cliffy spells one. */
export const rule = (label = RULE): Separator => ({ separator: label });

const toCliffy = <T>(items: Array<Item<T>>) =>
  items.map((item) =>
    isSeparator(item) ? { name: item.separator } : {
      value: item.value,
      name: item.name,
      ...(item.checked === undefined ? {} : { checked: item.checked }),
      ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
    }
  );

/** A line of output. Plain `console.log`, which is correct here: `setup` owns stdout, unlike the
 * MCP server where stdout is the protocol. */
export const say = (line = ''): void => console.log(line);

export type TextOptions = {
  message: string;
  default?: string;
  hint?: string;
  validate?: (value: string) => true | string;
};

export const askText = (options: TextOptions): Promise<string> =>
  Input.prompt({
    message: options.message,
    ...(options.default === undefined ? {} : { default: options.default }),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    // `files: true` is the one cliffy option that reaches readDir, and it would offer the working
    // directory as noise besides. Never enabled.
  });

export const askSecret = (options: TextOptions): Promise<string> =>
  Secret.prompt({
    message: options.message,
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
  });

export type PickOptions<T> = {
  message: string;
  items: Array<Item<T>>;
  /** Which value the cursor starts on. */
  default?: T;
  search?: boolean;
};

export const pick = <T>(options: PickOptions<T>): Promise<T> =>
  Select.prompt<T>({
    message: options.message,
    // deno-lint-ignore no-explicit-any -- cliffy's option union is wider than the subset used here
    options: toCliffy(options.items) as any,
    ...(options.default === undefined ? {} : { default: options.default }),
    ...(options.search ? { search: true } : {}),
  }) as Promise<T>;

export type CheckOptions<T> = {
  message: string;
  items: Array<Item<T>>;
  search?: boolean;
  /** Mirrors a schema rule where there is one — the people block needs at least one field. */
  min?: number;
};

export const check = <T>(options: CheckOptions<T>): Promise<T[]> =>
  Checkbox.prompt<T>({
    message: options.message,
    // deno-lint-ignore no-explicit-any -- as above
    options: toCliffy(options.items) as any,
    // One Enter submits. Cliffy asks for two by default, which reads as the first one not working.
    confirmSubmit: false,
    ...(options.search ? { search: true } : {}),
    ...(options.min === undefined ? {} : { minOptions: options.min }),
  }) as Promise<T[]>;

export const confirm = (options: { message: string; default?: boolean }): Promise<boolean> =>
  Confirm.prompt({
    message: options.message,
    ...(options.default === undefined ? {} : { default: options.default }),
  });

/** Whether there is a terminal to draw on. The barrier that keeps the two menus off an agent's
 * path: a Bash tool has no controlling terminal. Not a boundary — anything that can allocate a pty
 * gets past it — and both menus say so rather than implying otherwise. */
export const hasTerminal = (): boolean => Deno.stdin.isTerminal();
