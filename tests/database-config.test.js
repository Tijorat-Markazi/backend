"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { connectionOptions } = require("../db");
const env = { DB_HOST: "postgres", DB_PORT: "5432", DB_NAME: "tijorat_markazi_db",
  DB_USER: "tijorat_markazi_user", POSTGRES_PASSWORD: "test-only-$#'\\password" };
test("explicit shared database components preserve password characters", () => {
  assert.deepEqual(connectionOptions(env), { host: "postgres", port: 5432,
    database: env.DB_NAME, user: env.DB_USER, password: env.POSTGRES_PASSWORD });
});
test("partial component configuration never falls back to another database", () => {
  assert.equal(connectionOptions({ ...env, DATABASE_URL: "postgresql://wrong/other" }).database, env.DB_NAME);
  for (const name of Object.keys(env)) assert.throws(() => connectionOptions({ ...env, [name]: "", DATABASE_URL: "postgresql://wrong/other" }));
  for (const port of ["0", "65536", "5432;id", "-1"]) assert.throws(() => connectionOptions({ ...env, DB_PORT: port }));
});
test("legacy URLs remain usable for existing local and CI callers", () => {
  assert.deepEqual(connectionOptions({ DATABASE_URL: "postgresql://localhost/local" }), { connectionString: "postgresql://localhost/local" });
  assert.throws(() => connectionOptions({}));
});
