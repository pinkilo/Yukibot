const ts = require("@rollup/plugin-typescript")
const watch = require("rollup-plugin-watch")
const shebang = require("rollup-plugin-add-shebang")
const copy = require("rollup-plugin-copy")

module.exports = {
  input: "src/index.ts",
  output: {
    file: "build/yuki.js",
    format: "cjs",
  },
  plugins: [
    ts({outputToFilesystem: false}),
    watch({dir: "src"}),
    copy({targets: [{src: "assets", dest: "build"}]}),
    shebang({
      include: "yuki.js",
      shebang: "#!/usr/bin/env node",
    }),
  ],
  external: [
    "path",
    "fs",
    "dotenv",
    "eslint",
    "express",
    "googleapis",
    "typescript",
  ],
}