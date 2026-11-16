const { randomBytes, scryptSync } = require("node:crypto");

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$N=16384,r=8,p=1$${salt}$${derived.toString("hex")}`;
}

const password = process.argv[2] || "";
if (!password) {
  console.error("Usage: node scripts/hash-password.js <password>");
  process.exit(1);
}

console.log(hashPassword(password));
