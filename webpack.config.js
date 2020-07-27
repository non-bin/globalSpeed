const { resolve } = require("path")
const { env } = require("process")

const common = {
  entry: {
    contentScript: "./src/contentScript/index.ts",
    background: "./src/background/index.ts",
    popup: "./src/popup/popup.tsx",
    options: "./src/options/options.tsx",
    faqs: "./src/faqs/faqs.tsx",
    ctx: "./src/contentScript/ctx.ts"
  },
  output: {
    path: resolve(__dirname, env.FIREFOX ? "buildFf": "build", "unpacked")
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: "babel-loader"
      },
      {
        test: /\.scss$/,
        use: [
            "style-loader", // creates style nodes from JS strings
            "css-loader", // translates CSS into CommonJS
            "sass-loader" // compiles Sass to CSS, using Node Sass by default
        ]
      }
    ]
  },
  resolve: {
    extensions: [".tsx", ".ts", '.js']
  }
}

if (env.NODE_ENV === "production") {
  module.exports = {
    ...common,
    mode: "production"
  }
} else {
  module.exports = {
    ...common,
    mode: "development",
    devtool: false
    // devtool: "eval-source-map" // requires manifest to be loosened into "content_security_policy": "script-src 'self' 'unsafe-eval'; object-src 'self'"
  }
}