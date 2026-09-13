import { imageSize } from "image-size";
import { describe, expect, it } from "vitest";

describe("image-size security patch", () => {
  it("rejects an ICNS header whose declared file length is invalid", () => {
    const malformedIcn = Buffer.from([
      0x69, 0x63, 0x6e, 0x73, // icns
      0x00, 0x00, 0x00, 0x00, // invalid declared file length
    ]);

    expect(() => imageSize(malformedIcn)).toThrow();
  });

  it("terminates instead of looping on a zero-length ISO box", () => {
    const zeroLengthBox = Buffer.from([
      0x00, 0x00, 0x00, 0x00, // box size zero
      0x66, 0x74, 0x79, 0x70, // ftyp
      0x68, 0x65, 0x69, 0x63, // heic brand
      0x00, 0x00, 0x00, 0x00,
    ]);

    expect(() => imageSize(zeroLengthBox)).toThrow();
  });
});
