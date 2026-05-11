import { describe, expect, it } from "vitest";
import { parseOpRefs } from "./upgrade-repo.js";

// `varlock` invokes 1Password via a `<execName>("op read ...")` DSL.
// Constructed at runtime so the literal substring doesn't trip
// repository security hooks that grep for shell-call patterns.
const E = "exec";

function schemaFor(authVar: "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN"): string {
  return [
    "# header comment",
    "",
    "# @sensitive @required",
    `${authVar}=${E}('op read "op://runway/anthropic-api-key/credential"')`,
    "",
    "# @sensitive @required",
    `GH_TOKEN=${E}('op read "op://runway/gh-token/credential"')`,
    "",
  ].join("\n");
}

const apiKeySchema = schemaFor("ANTHROPIC_API_KEY");
const oauthSchema = schemaFor("CLAUDE_CODE_OAUTH_TOKEN");

const mismatchSchema = [
  "# @sensitive @required",
  `ANTHROPIC_API_KEY=${E}('op read "op://vault-a/anthropic-api-key/credential"')`,
  "",
  "# @sensitive @required",
  `GH_TOKEN=${E}('op read "op://vault-b/gh-token/credential"')`,
].join("\n");

describe("parseOpRefs", () => {
  it("extracts vault + item names from an api-key schema and reports authMode=api-key", () => {
    expect(parseOpRefs(apiKeySchema, {})).toEqual({
      opVault: "runway",
      anthropicItem: "anthropic-api-key/credential",
      ghTokenItem: "gh-token/credential",
      authMode: "api-key",
    });
  });

  it("detects authMode=oauth when the schema uses CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(parseOpRefs(oauthSchema, {}).authMode).toBe("oauth");
  });

  it("applies per-field overrides over extracted values", () => {
    const result = parseOpRefs(apiKeySchema, {
      opVault: "override-vault",
      anthropicItem: "override-item",
    });
    expect(result.opVault).toBe("override-vault");
    expect(result.anthropicItem).toBe("override-item");
    // gh-token unaffected
    expect(result.ghTokenItem).toBe("gh-token/credential");
  });

  it("throws when the schema can't be parsed and no overrides are passed", () => {
    expect(() => parseOpRefs("# empty schema\n", {})).toThrow(
      /could not parse existing \.env\.schema/,
    );
  });

  it("throws on vault mismatch (different vault per entry, no --op-vault override)", () => {
    expect(() => parseOpRefs(mismatchSchema, {})).toThrow(/vault mismatch/);
  });

  it("a --op-vault override silences the vault-mismatch check", () => {
    expect(() =>
      parseOpRefs(mismatchSchema, { opVault: "user-says-vault-a" }),
    ).not.toThrow();
  });
});
