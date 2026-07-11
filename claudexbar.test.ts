import { describe, expect, test } from "bun:test";
import { decodeMacOSKeychainSecret, formatCredits } from "./claudexbar";

describe("decodeMacOSKeychainSecret", () => {
    test("decodes hex-encoded Keychain data", () => {
        expect(decodeMacOSKeychainSecret("7b226f6b223a747275657d\n")).toBe('{"ok":true}');
    });

    test("preserves plain JSON Keychain strings", () => {
        expect(decodeMacOSKeychainSecret('  {"ok":true}\n')).toBe('{"ok":true}');
    });
});

describe("formatCredits", () => {
    test("keeps whole reset credits compact", () => {
        expect(formatCredits(1)).toBe("1");
    });

    test("keeps useful fractional precision", () => {
        expect(formatCredits(1.5)).toBe("1.5");
    });
});
