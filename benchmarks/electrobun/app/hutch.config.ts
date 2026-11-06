// @hutch cli=0.29.0 cottontail=0.7.3
export default {
  scripts: {
    install: ['hutch', 'install', '--frozen-lockfile'],
    start: ['hutch', 'electrobun', 'dev'],
    dev: ['hutch', 'electrobun', 'dev', '--watch'],
    build: ['hutch', 'electrobun', 'build', '--env=stable'],
  },
  electrobun: {
    version: '2.0.6',
  },
}
