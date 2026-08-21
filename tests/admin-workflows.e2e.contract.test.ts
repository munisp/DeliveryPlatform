import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

describe("administrator browser workflow contracts", () => {
  it("keeps MFA enrollment and financial administration routes reachable through protected dashboard navigation", () => {
    const securityProfile = readFileSync(resolve(root, "client/src/pages/SecurityProfile.tsx"), "utf8");
    const financialAdmin = readFileSync(resolve(root, "client/src/pages/FinancialAdministration.tsx"), "utf8");
    const app = readFileSync(resolve(root, "client/src/App.tsx"), "utf8");
    expect(securityProfile).toContain("Set up MFA");
    expect(securityProfile).toContain("Open identity-provider security");
    expect(securityProfile).toContain("Generate recovery codes in the identity provider");
    expect(financialAdmin).toContain("Financial administration is restricted");
    expect(financialAdmin).toContain("requires an authenticated platform financial administrator with verified MFA");
    expect(app).toContain("FinancialAdministration");
    expect(app).toContain("SecurityProfile");
  });
});
