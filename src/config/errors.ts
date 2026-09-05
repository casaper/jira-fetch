/** Raised for anything wrong with the configuration: a malformed file, an invalid filter rule,
 * or missing credentials. Always maps to exit code 2. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}
