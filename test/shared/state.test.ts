import { describe, expect, it } from "vitest";
import { selectDisplayError } from "../../src/shared/state.js";

describe("selectDisplayError", () => {
  it("returns null for no errors", () => {
    expect(selectDisplayError([])).toBeNull();
  });
  it("microphone overrides media", () => {
    expect(selectDisplayError(["MEDIA_FAILED", "MICROPHONE_BLOCKED"])).toBe("MICROPHONE_BLOCKED");
  });
  it("media overrides registration", () => {
    expect(selectDisplayError(["REGISTRATION_FAILED", "MEDIA_FAILED"])).toBe("MEDIA_FAILED");
  });
  it("registration overrides connection", () => {
    expect(selectDisplayError(["CONNECTION_LOST", "REGISTRATION_FAILED"])).toBe("REGISTRATION_FAILED");
  });
  it("connection lost alone", () => {
    expect(selectDisplayError(["CONNECTION_LOST"])).toBe("CONNECTION_LOST");
  });
});
