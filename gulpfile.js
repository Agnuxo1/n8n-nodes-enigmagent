const { src, dest, series } = require('gulp');

/**
 * Copy SVG icons from source nodes/* directories into the matching dist/nodes/*
 * directories so that n8n can find them at runtime. tsc only compiles .ts.
 */
function buildIcons() {
  return src('nodes/**/*.{png,svg}').pipe(dest('dist/nodes'));
}

function buildCredentialsIcons() {
  return src('credentials/**/*.{png,svg}').pipe(dest('dist/credentials'));
}

exports['build:icons'] = series(buildIcons, buildCredentialsIcons);
exports.default = series(buildIcons, buildCredentialsIcons);
