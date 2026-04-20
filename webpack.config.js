const path = require('path');

module.exports = {
  mode: 'development',
  target: 'node',
  entry: {
    extension: './src/extension.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    // Redirect `require('alasql')` to the browser/standard build so webpack
    // does not pull in the alasql.fs.js build which has react-native peer deps.
    alias: {
      alasql: path.resolve(__dirname, 'node_modules/alasql/dist/alasql.js'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  devtool: 'nosources-source-map',
};
