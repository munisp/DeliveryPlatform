const path = require("node:path");

const packageRoot = process.argv[2];
if (!packageRoot) {
  throw new Error("Pass the resolved image-size package directory as the first argument");
}

const { ICNS } = require(path.join(packageRoot, "dist/types/icns.js"));
const boxTraversal = require("node:fs").readFileSync(path.join(packageRoot, "dist/types/utils.js"), "utf8");
if (!boxTraversal.includes("offset += box.size > 0 ? box.size : 8;")) {
  throw new Error("image-size JXL/HEIF zero-size box guard is absent");
}
const zeroLengthEntry = Uint8Array.from([
  0x69,
  0x63,
  0x6e,
  0x73, // icns
  0x00,
  0x00,
  0x00,
  0x10, // declared file length: 16 bytes
  0x69,
  0x63,
  0x30,
  0x37, // ic07
  0x00,
  0x00,
  0x00,
  0x00, // zero entry length: historic infinite-loop trigger
]);

let error;
try {
  ICNS.calculate(zeroLengthEntry);
} catch (caught) {
  error = caught;
}

if (!(error instanceof TypeError) || error.message !== "Invalid ICNS entry length") {
  throw new Error("image-size ICNS patch did not reject the zero-length entry deterministically");
}

console.log("PASS: image-size ICNS entry and JXL/HEIF box zero-length parser loops are guarded");
