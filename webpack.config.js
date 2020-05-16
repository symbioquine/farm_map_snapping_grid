const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const info = require('./package.json');

module.exports = {
  entry: `${__dirname}/src/main.js`,
  output: {
    path: `${__dirname}/build/farm_map_snapping_grid`,
    filename: 'farmOS.map.behaviors.farm_map_snapping_grid.js',
  },
  performance: {
    hints: false,
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [
          { loader: 'style-loader' },
          { loader: 'css-loader' },
        ],
      },
    ],
  },
  plugins: [
    new webpack.BannerPlugin(`farm_map_snapping_grid v${info.version}`),
    new CopyWebpackPlugin([
      { from: 'static' },
    ]),
  ],
};
